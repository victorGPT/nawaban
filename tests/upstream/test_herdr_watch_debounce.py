#!/usr/bin/env python3
"""--once 去抖:干活中的 pane 闪一下 done 不算信号,真的停住才算。

真机取样(2026-09-09 · herdr socket 订阅 w1:p4X 64s):瞬时 done 只持续 0.21~0.33s,
下面 REAL_FLAP 就是那段原始时间线,一秒不差地抄进来当夹具。
跑法:python3 foreman/tests/test_herdr_watch_debounce.py(零依赖 · 约 0.7s)
"""
import importlib.util
import os
import time

spec = importlib.util.spec_from_file_location(
    "hew", os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "herdr_events_watch.py"))
hew = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hew)


def replay(events, hold=3.0, until=None):
    """按 (秒, pane, 状态) 喂进去,返回被判定为真信号的 (名字, 状态) 列表。"""
    d = hew.Debouncer(hold=hold)
    fired = []
    clock = 0.0
    for at, pane, status in events:
        while True:  # 走到 at 之前先把已到期的信号收掉
            wait = d.wait(clock)
            if wait is None or clock + wait > at:
                break
            clock += wait
            hit = d.due(clock)
            if hit is not None:
                fired.append(hit)
        clock = at
        d.observe(pane, pane.upper(), status, clock)
    clock = (events[-1][0] if events else 0.0) if until is None else until
    while (hit := d.due(clock)) is not None:
        fired.append(hit)
    return fired


REAL_FLAP = [(0.0, "working"), (3.68, "done"), (4.0, "working"), (4.85, "done"),
             (5.16, "working"), (8.84, "done"), (9.15, "working"), (9.78, "done"),
             (10.09, "working"), (13.68, "done"), (13.99, "working"), (14.94, "done"),
             (15.25, "working"), (17.67, "done")]

# 1) 真机抖动:6 次闪 done,一次都不该醒(第 7 次 17.67s 还没熬够 3s 就收尾)
fired = replay([(t, "pA", s) for t, s in REAL_FLAP])
assert fired == [], f"真机抖动被误判成信号: {fired}"

# 2) 同一段抖动,末尾那次 done 停住不动:到 20.67s 才刚好熬够,恰好报一次
fired = replay([(t, "pA", s) for t, s in REAL_FLAP], until=17.67 + 3.0)
assert fired == [("PA", "done")], f"真停住的 done 没报或报多了: {fired}"

# 3) 熬够之后不重复报:再等多久也只有那一次
fired = replay([(t, "pA", s) for t, s in REAL_FLAP], until=17.67 + 300)
assert fired == [("PA", "done")], f"同一次 done 报了多遍: {fired}"

# 4) 两个 pane 互不干扰:A 真停住,B 在旁边狂抖,不许把 A 的信号顶掉
fired = replay([(0.0, "pA", "done"),
                (0.5, "pB", "done"), (0.8, "pB", "working"),
                (1.5, "pB", "done"), (1.8, "pB", "working")], until=5.0)
assert fired == [("PA", "done")], f"B 的抖动串了 A 的信号: {fired}"

# 5) blocked / idle 同样走去抖:闪一下不报,停住报
assert replay([(0.0, "pA", "blocked"), (0.3, "pA", "working")], until=9.0) == []
assert replay([(0.0, "pA", "idle")], until=9.0) == [("PA", "idle")]

# 6) hold=0 时退回改前行为(一来就报),给环境变量留的退路是真能退的
assert replay([(0.0, "pA", "done")], hold=0.0, until=0.0) == [("PA", "done")]

# 7) 信号态之间迁移不重新计时:计时点是「离开 working」那一刻,不是「进入当前状态」
#    done@0 → idle@2.9(全程没回过 working)应该 3.0s 就报 idle,不是拖到 5.9s
fired = replay([(0.0, "pA", "done"), (2.9, "pA", "idle")], until=3.0)
assert fired == [("PA", "idle")], f"done→idle 被重新计时了: {fired}"


# ---- 下面几条打的是消费循环本身,不是 Debouncer 纯逻辑 ----
from queue import Queue  # noqa: E402


def drain(events, hold=0.2, cap=0.05):
    q: Queue = Queue()
    for e in events:
        q.put(e)
    return hew.next_signal(q, hew.Debouncer(hold=hold), cap=cap)


# 8) 先排空再判定:pending 已熬过 hold,而作废它的 working 还躺在队列里没轮到消费 ——
#    判定若跑在排空之前,这条陈旧 done 就会被捞走,正是要去掉的假唤醒
assert drain([("pA", "PA", "done"), ("pA", "PA", "working")]) is None
q0: Queue = Queue()
d0 = hew.Debouncer(hold=0.05)
q0.put(("pA", "PA", "done"))
assert hew.next_signal(q0, d0, cap=0.0) is None      # 建立 pending,不等
q0.put(("pA", "PA", "working"))                      # 抖回去了,消费侧还没看见
time.sleep(0.06)                                     # pending 这时已经熬过 hold
assert hew.next_signal(q0, d0, cap=0.05) is None, "陈旧 done 抢在 working 之前被捞走了"

# 9) 多 pane 同时抖出的 backlog 同理:A 真停住 + B 满屏抖,只该报 A
q: Queue = Queue()
q.put(("pA", "PA", "done"))
for _ in range(20):
    q.put(("pB", "PB", "done"))
    q.put(("pB", "PB", "working"))
got = hew.next_signal(q, hew.Debouncer(hold=0.05), cap=1.0)
assert got == ("PA", "done"), f"backlog 里该只报 A: {got}"

# 10) 断线哨兵(None)作废 pending:断线期间 pane 回没回 working 消费侧永远不知道,
#     只能一律作废,否则「done 后 0.2s 断线」= 保证 hold 秒后误报
assert drain([("pA", "PA", "done"), None]) is None
q = Queue(); q.put(("pA", "PA", "done")); q.put(None)
d = hew.Debouncer(hold=0.05)
assert hew.next_signal(q, d, cap=0.05) is None
time.sleep(0.1)
assert hew.next_signal(q, d, cap=0.05) is None, "断线后 pending 还熬熟了"

# 11) 正常通路:队列里只有一条 done,等够 hold 就报出来
q = Queue(); q.put(("pA", "PA", "done"))
assert hew.next_signal(q, hew.Debouncer(hold=0.1), cap=1.0) == ("PA", "done")

# 12) 生产线程无论怎么退出都要塞哨兵:漏了的话最后那个 pending 必然熬熟报出去
#     (一次假唤醒),之后队列永远空,watcher 静默降级成只看信件
import contextlib  # noqa: E402
import io  # noqa: E402
import threading  # noqa: E402

hew.BACKOFF = 0.02
for boom in (ValueError("畸形事件"), ConnectionError("socket 断了")):
    q2: Queue = Queue()
    fired = []

    def blow_up_once(signals, exc=boom, fired=fired):
        if fired:
            time.sleep(60)      # 只炸第一轮,别让 daemon 线程刷屏
        fired.append(1)
        raise exc

    hew.watch = blow_up_once
    with contextlib.redirect_stderr(io.StringIO()):
        threading.Thread(target=hew.listen, args=(q2,), daemon=True).start()
        time.sleep(0.1)
    assert q2.get_nowait() is None, f"{boom!r} 打死线程时没塞哨兵"

print(f"OK · 真机 {len(REAL_FLAP)} 条迁移零误唤醒;backlog / 断线 / done→idle / 线程猝死 四个坑各有一条守着")
