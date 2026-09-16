#!/usr/bin/env python3
"""把窗口已经不在的卡放回可认领(WORKOS-RECLAIM-STALE-001)。

**为什么不能靠收尾**:实测装了 SessionEnd hook + Stop hook + 两个 wrapup skill,
仍有 57% 的 claimed/in_progress 卡挂着一个不存在的窗口(最久 9.2 天)。原因是结构性的:
Stop hook 每轮触发不是 session 结束触发;SessionEnd 里没有 foreman 动作;而 `/clear`
与关窗是**人的动作**,agent 根本没有执行收尾的机会。指望自觉 = 指望一个不会被调用的函数。

Live Herdr agents protect their owners, including Codex sessions. If the Herdr
inventory is unavailable, the sweep defers reclamation. Otherwise, Claude and
Codex transcript mtimes retain the existing age thresholds below.

**信号从哪来**:转录 jsonl 的 mtime —— 它是运行时 I/O 的副作用,不是谁的自觉动作,
所以不会因为 agent 忘了收尾而失真。(同款判断见 Hermes:他们把每次 API 活动桥接进
last_heartbeat_at;我们的 mtime 天然就是那个东西,缺的只是把它写回卡这一步。)

**已知漏网,刻意接受**:mtime 是「窗口活性」不是「任务活性」—— 同一个窗口 claim 了卡 A
不收尾、接着在同一 session 里干别的,jsonl 一直在长,卡 A 就一直判活。硬补的代价
(把阈值压到逼所有窗口频繁续期)大于收益。而用户点名的核心痛点 `/clear` 恰好覆盖:
它起新 session id,旧 jsonl 从此冻结。

用法:
    python3 ~/.claude/foreman/workos/reclaim_stale.py            # dry-run
    python3 ~/.claude/foreman/workos/reclaim_stale.py --apply    # 真写
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from workos import db  # noqa: E402

# Session-derived owners use Claude or Codex transcript mtimes.
# 24h 而不是跟活性三档的 cold(8h)对齐:隔夜回到同一个窗口继续干是常态,
# 8h 会把它误判成死。误回收的代价小(重新 claim 一条命令),但噪音会让人不信这个机制。
SESSION_STALE_H = 24
# 不认得的 owner(grok / codex:root / ac-main 这类非 session 派生)—— 没有任何活性信号,
# 只能拿「最后一条事件多久没动」当替代,所以阈值放长。不豁免:留着它们永远沉底更坏。
FOREIGN_STALE_H = 72


def _transcript_mtimes() -> dict[str, float]:
    """session id 前 8 位 → 转录最后修改时间。"""
    out: dict[str, float] = {}
    for f in glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl")):
        key = os.path.basename(f)[:8]
        out[key] = max(out.get(key, 0.0), os.path.getmtime(f))
    for f in glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/rollout-*.jsonl")):
        key = Path(f).stem[-36:][:8]
        out[key] = max(out.get(key, 0.0), os.path.getmtime(f))
    return out


def _herdr_owners() -> set[str] | None:
    """Return live owner identities; an unavailable inventory is not evidence of death."""
    try:
        result = subprocess.run(
            ["herdr", "agent", "list"], capture_output=True, text=True,
            check=True, timeout=5,
        )
        agents = json.loads(result.stdout)["result"]["agents"]
        if not isinstance(agents, list):
            raise ValueError("agents is not a list")
        owners: set[str] = set()
        for agent in agents:
            session = agent["agent_session"]
            if session["kind"] != "id" or not session["value"]:
                raise ValueError("agent session identity unavailable")
            owners.add(f"ac:{session['value'][:8]}")
            if agent.get("name"):
                owners.add(f"{agent['agent']}:{agent['name']}")
        return owners
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as e:
        print(f"回收暂缓:Herdr 活性查询不可用({e})", file=sys.stderr)
        return None


def _judge(owner: str, last_event_at: int | None, mtimes: dict[str, float],
           now: float) -> tuple[bool, str]:
    """(该不该回收, 判据原文)。判据原文要能让人复核,不能只给结论。"""
    if owner.startswith("ac:"):
        m = mtimes.get(owner.split(":", 1)[1][:8])
        if m is None:
            return True, "转录文件找不到(窗口已不存在)"
        age_h = (now - m) / 3600
        if age_h > SESSION_STALE_H:
            return True, f"转录 {age_h:.1f}h 没动(阈值 {SESSION_STALE_H}h)"
        return False, f"转录 {age_h:.1f}h 前还在动"
    # 非 session 派生的 owner:mtime 判据完全无效,退到「最后一条事件」这个弱信号
    if last_event_at is None:
        return True, f"owner 形态 {owner!r} 无活性信号,且卡上没有任何事件"
    age_h = (now - last_event_at) / 3600
    if age_h > FOREIGN_STALE_H:
        return True, (f"owner 形态 {owner!r} 无活性信号,最后一条事件 {age_h / 24:.1f} 天前"
                      f"(阈值 {FOREIGN_STALE_H // 24} 天)")
    return False, f"owner 形态 {owner!r} 无活性信号,但 {age_h:.1f}h 前还有事件"


def sweep(path: Path, *, apply: bool = False) -> list[tuple[str, str, str, str]]:
    """扫一遍,返回 [(task_id, owner, status, 判据)]。``apply`` 才真写。

    抽出来是为了让 SessionStart hook 直接调 —— hook 要的是「回收了几张」这一个数,
    不是整页输出。
    """
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT t.id, t.owner, t.status, MAX(e.created_at)"
            " FROM tasks t LEFT JOIN task_events e ON e.task_id = t.id"
            " WHERE t.status IN ('claimed','in_progress') AND t.owner IS NOT NULL"
            " GROUP BY t.id"
        ).fetchall()
    finally:
        con.close()

    now = time.time()
    mtimes = _transcript_mtimes()
    live_owners = _herdr_owners()
    if live_owners is None:
        return []
    out: list[tuple[str, str, str, str]] = []
    for tid, owner, st, ev in rows:
        if owner in live_owners:
            continue
        ok, why = _judge(owner, ev, mtimes, now)
        if not ok:
            continue
        if apply and not db.reclaim_task(path, tid, expected_owner=owner, reason=why):
            continue          # CAS 未命中:期间被别人接手了,不算回收
        out.append((tid, owner, st, why))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="reclaim_stale", description="回收窗口已不在的卡")
    ap.add_argument("--db", help="库路径(默认就近 .foreman/workos.db)")
    ap.add_argument("--apply", action="store_true", help="真写(缺省只打印)")
    a = ap.parse_args(argv)

    path = Path(a.db) if a.db else db.resolve_db()
    tag = "真写" if a.apply else "dry-run(加 --apply 才写)"
    try:
        stale = sweep(path, apply=a.apply)
    except (db.WorkosError, sqlite3.Error) as e:
        print(f"✗ 回收没跑成:{e}", file=sys.stderr)
        return 1
    print(f"库:{path}\n{tag} · 判定窗口已不在 {len(stale)} 张"
          f"{'(已退回 open)' if a.apply else ''}\n")
    for tid, owner, st, why in sorted(stale, key=lambda x: x[0]):
        print(f"  {st:14} {tid:34} {owner}")
        print(f"      判据:{why}")
    if not a.apply and stale:
        print("\n看着对 → 同样命令加 --apply")
    return 0


if __name__ == "__main__":
    sys.exit(main())
