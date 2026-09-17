#!/usr/bin/env python3
"""herdr 事件推送监听(v1 · 2026-08-10 读 socket-api 文档后建)。

取代 90s 轮询:直连 herdr unix socket,events.subscribe 订阅全部
pane.agent_status_changed,过滤指定前缀的 agent,状态迁移实时打一行。
- 每行 stdout = 一次状态迁移(给 Claude Monitor 当事件流)
- 只报"值得总监醒"的迁移:→ blocked(卡确认框)/ → done(后台干完没人看)/ → idle(回合结束)
- 协议:JSONL over unix socket;订阅按 pane_id 逐个下发(schema: required type+pane_id)
- `--once` 去抖(2026-09-09):要连续处于 blocked/done/idle 满 HERDR_WATCH_DEBOUNCE 秒才算一次真信号。
  干活中的 pane 每跨一次工具调用边界就闪一下 done/idle,不去抖等于每秒级刷醒总监。
  真机 590s 采样:287 次瞬时 done/idle 全部 <0.5s,真停住的 2 次 ≥10s,
  0.5~10s 这一段一个样本都没有——3s 就落在这条空隙正中间。
  样本全来自 claude pane,codex 的抖动时长没测过,这就是留这个环境变量的原因。
用法:herdr_events_watch.py <agent名前缀>[,前缀2…] [--once]
"""
import argparse
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from queue import Empty, Queue
from threading import Thread

SOCK = os.path.expanduser(os.environ.get("HERDR_SOCKET_PATH", "~/.config/herdr/herdr.sock"))
PREFIXES: tuple[str, ...] = ()  # main() 按命令行填;import 本模块只为测 Debouncer
SIGNAL_STATES = ("blocked", "done", "idle")
BACKOFF = 15.0  # 一段连接结束到下一次重连/重扫之间的退避


class Debouncer:
    """持续处于 blocked/done/idle 满 hold 秒才算一次真信号,中途跳去别的状态就作废。

    (herdr 的状态词表是 idle/working/blocked/done/unknown 五个,unknown 同样作废。)
    """

    def __init__(self, hold: float | None = None) -> None:
        # env 到构造时才解析:写错只崩启动的那一下,不至于连 --help 都跑不了
        self.hold = float(os.environ.get("HERDR_WATCH_DEBOUNCE", "3")) if hold is None else hold
        self.pending: dict[str, tuple[float, str, str]] = {}  # pane -> (到期, 名字, 状态)

    def observe(self, pane: str, name: str, status: str, now: float) -> None:
        if status not in SIGNAL_STATES:
            self.pending.pop(pane, None)  # 闪回 working 之类 = 刚才那下是抖动
            return
        # 起算于「首次观测到它进了信号态」——done→idle 只是换个理由,不重新计时。
        # herdr 不重放状态,pane 真正离开 working 的时刻我们无从得知,只能从首次观测起算
        # (方向保守:只会等更久,不会提前报)。
        deadline = self.pending.get(pane, (now + self.hold, "", ""))[0]
        self.pending[pane] = (deadline, name, status)

    def feed(self, event: tuple[str, str, str] | None, now: float) -> None:
        """None = 一段连接结束:断线期间的迁移永远送不到,pending 只能一律作废。"""
        if event is None:
            self.pending.clear()
        else:
            self.observe(*event, now)

    def due(self, now: float) -> tuple[str, str] | None:
        """最早熬过 hold 的信号;每个 pane 只报一次。"""
        ripe = sorted((d, p) for p, (d, _, _) in self.pending.items() if d <= now)
        if not ripe:
            return None
        _, name, status = self.pending.pop(ripe[0][1])
        return name, status

    def wait(self, now: float) -> float | None:
        """下次该醒来还有几秒;没有 pending 就 None。"""
        if not self.pending:
            return None
        return max(0.0, min(d for d, _, _ in self.pending.values()) - now)


def tracked_panes() -> dict[str, str]:
    """agent 名前缀匹配 → {pane_id: agent_name}(用 CLI 拿一次现状,不自己猜)。"""
    out = subprocess.run(["herdr", "agent", "list"], capture_output=True, text=True).stdout
    panes = {}
    try:
        for a in json.loads(out)["result"].get("agents", []):
            name = str(a.get("name") or "")
            if name.startswith(PREFIXES):
                panes[a["pane_id"]] = name
    except Exception:
        pass
    return panes


def watch(signals: "Queue[tuple[str, str, str] | None] | None" = None) -> None:
    panes = tracked_panes()
    if not panes:
        if signals is None:
            print(f"(无匹配前缀 {PREFIXES} 的 agent,{BACKOFF:.0f}s 后重扫)", flush=True)
        return
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(SOCK)
        with s.makefile("rw", encoding="utf-8") as f:
            subs = [{"type": "pane.agent_status_changed", "pane_id": p} for p in panes]
            f.write(json.dumps({"id": "watch1", "method": "events.subscribe",
                                "params": {"subscriptions": subs}}) + "\n")
            f.flush()
            ack = f.readline()  # 首行 = 订阅确认
            if not ack:
                raise ConnectionError("订阅无响应")
            last: dict[str, str] = {}
            for line in f:  # 之后每行 = 推送事件(阻塞读,零轮询)
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if signals is not None:
                    if ev.get("event") != "pane.agent_status_changed":
                        continue
                    data = ev.get("data") or {}
                    if data.get("pane_id") not in panes:
                        continue
                else:
                    data = next((c for c in (ev.get("event"), ev.get("params"), ev)
                                 if isinstance(c, dict)), {})
                pane = data.get("pane_id", "")
                status = str(data.get("agent_status") or "")
                name = panes.get(pane, pane)
                if status and status != last.get(pane):
                    if signals is not None:
                        # 连 working 一起上报:消费侧要靠它判定刚才那下是不是抖动
                        signals.put((pane, name.upper(), status))
                    elif status in SIGNAL_STATES:
                        icon = {"blocked": "⏸ 卡确认框/提问", "done": "✅ 后台干完(未看)", "idle": "💤 回合结束"}[status]
                        print(f"{icon}: {name}", flush=True)
                last[pane] = status


def listen(signals: "Queue[tuple[str, str, str] | None] | None" = None) -> None:
    while True:
        try:
            watch(signals)
        except Exception as exc:  # 这个线程死了没人接手,只能宽捕获后退避重连
            print(f"(watcher 中断:{exc!r} · {BACKOFF:.0f}s 后重连)",
                  file=sys.stdout if signals is None else sys.stderr, flush=True)
        finally:
            # 必须走 finally:线程猝死却不作废 pending,消费侧会先误唤醒一次再永久失明
            if signals is not None:
                signals.put(None)
        time.sleep(BACKOFF)  # 干净 EOF 也走这里,否则就是忙重连


def next_signal(signals: "Queue[tuple[str, str, str] | None]", debouncer: Debouncer,
                cap: float = 15.0) -> tuple[str, str] | None:
    """排空队列 → 收熬熟的信号 → 都没有就睡到下一个到期点(至多 cap 秒)。

    cap 必须 > 0:cap=0 且队列空时本函数立刻返回 None,调用方的 while 就成了满核空转。

    「先排空再判定」是承重的:一条 done 到底是不是抖动,答案躺在它后面那条 working 里。
    判定跑在排空之前,消费侧一落后(信件查询慢、多 pane 同时抖出 backlog),
    陈旧的 done 就会自己熬熟被捞走 —— 那正是要去掉的假唤醒。
    """
    while True:
        try:
            debouncer.feed(signals.get_nowait(), time.monotonic())
        except Empty:
            break
    hit = debouncer.due(time.monotonic())
    if hit is not None:
        return hit
    wait = debouncer.wait(time.monotonic())
    try:
        debouncer.feed(signals.get(timeout=cap if wait is None else min(cap, wait)),
                       time.monotonic())
    except Empty:
        pass
    return debouncer.due(time.monotonic())


def watch_once() -> None:
    from nawaban.db import resolve_db

    query = ("SELECT letters.task_id, tasks.status || '/' || letters.kind FROM letters "
             "JOIN tasks ON tasks.id = letters.task_id WHERE read_at IS NULL AND (")
    query += " OR ".join("letters.task_id LIKE ? ESCAPE '\\'" for _ in PREFIXES)
    query += ") ORDER BY letters.id LIMIT 1"
    prefixes = [p.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                for p in PREFIXES]
    signals: "Queue[tuple[str, str, str] | None]" = Queue()
    debouncer = Debouncer()
    with closing(sqlite3.connect(resolve_db().resolve().as_uri() + "?mode=ro", uri=True)) as con:
        Thread(target=listen, args=(signals,), daemon=True).start()
        while True:
            row = con.execute(query, prefixes).fetchone()
            if row is not None:
                break
            row = next_signal(signals, debouncer)
            if row is not None:
                break
        task_id, status = row
        print(f"卡#{task_id} · {status} · [herdr agent read {task_id.lower()}]", flush=True)


def main() -> None:
    global PREFIXES
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prefix", nargs="?")
    parser.add_argument("--once", action="store_true",
                        help="Exit on an unread letter or a pane signal")
    args = parser.parse_args()
    if args.once and args.prefix is None:
        parser.error("--once requires a family prefix")
    PREFIXES = tuple((args.prefix if args.prefix is not None else "pi-loop,obs-").split(","))
    if args.once:
        if any(not prefix.strip() for prefix in PREFIXES):
            parser.error("--once requires nonempty family prefixes")
        PREFIXES = tuple(prefix.lower() for prefix in PREFIXES)
        watch_once()
    else:
        listen()


if __name__ == "__main__":
    main()
