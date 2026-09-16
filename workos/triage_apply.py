#!/usr/bin/env python3
"""把巡检 agent 的建议落进 asks 表(INBOX-TRIAGE-AGENT-001 的收口)。

分工是刻意的:**巡检包(产品层)连写路径都没有**,它只出 JSON;写库这一步在这里,
在人这一侧。所以「agent 能改什么」在结构上就封死了,不靠它自觉。

用法:
    INBOX_TRIAGE_ENABLED=1 uv run python -m agent_center.triage --json > /tmp/t.json
    python3 ~/.claude/foreman/workos/triage_apply.py /tmp/t.json          # dry-run
    python3 ~/.claude/foreman/workos/triage_apply.py /tmp/t.json --apply  # 真写

默认 dry-run:往人的队列里塞东西跟往代码里塞东西一样,得先看清楚再落。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from workos import db  # noqa: E402
from workos.migrate_asks import _waiting_since  # noqa: E402

RAISED_BY = "ac:triage"


def _ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _waiting_from_cards(path: Path, task_ids: list[str]) -> int | None:
    """这个问题从什么时候开始等人 = 底卡里等得最久的那张的起点。

    不继承的话新提的 ask 一律 0d,「按停滞排序」当场失效 —— 收件箱把最新的捧上首屏,
    正是这套机制要对抗的东西。落 0d 等于往人的队列里写一个假状态。

    取 min 而非 max 是刻意的:一个 ask 挂 30 张卡时,人欠的是「这批活积压了多久」,
    不是「最后一张什么时候就绪」。级联多闸(G1→G4)下 min 会显得等得更久 —— 那正是要的
    信号;取 max 会让刚补齐最后一闸的老积压显示成新事,正是收件箱要对抗的那个偏向。
    """
    con = _ro(path)
    try:
        stamps = [t for t in (_waiting_since(con, tid) for tid in task_ids) if t]
    finally:
        con.close()
    return min(stamps) if stamps else None


def _all_done(path: Path, ask_id: int) -> bool:
    """底卡是否全部 done —— 决定关闭态是 task_closed 还是 withdrawn。

    按数据判,不按 agent 自报的理由判:两种关闭态的统计意义不同
    (task_closed = 事情办完了自然消失;withdrawn = 这个问题作废了)。
    """
    con = _ro(path)
    try:
        rows = con.execute(
            "SELECT status FROM tasks WHERE id IN"
            " (SELECT task_id FROM ask_tasks WHERE ask_id=?)", (ask_id,)).fetchall()
    finally:
        con.close()
    return bool(rows) and all(r[0] == "done" for r in rows)


def _dup_key(question: str, task_ids: list[str]) -> tuple[str, tuple[str, ...]]:
    """判重键:同一个问题挂同一组卡 = 同一件事。巡检是定期跑的,不去重会越跑越多。"""
    return (" ".join(question.split()), tuple(sorted(task_ids)))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="triage_apply", description="巡检建议落库")
    ap.add_argument("json_file", help="agent_center.triage --json 的输出")
    ap.add_argument("--db", help="库路径(默认 WORKOS_DB → 就近 .foreman/workos.db)")
    ap.add_argument("--apply", action="store_true", help="真写(缺省只打印)")
    a = ap.parse_args(argv)

    path = Path(a.db) if a.db else db.resolve_db()
    data = json.loads(Path(a.json_file).read_text())
    proposals = data.get("proposals") or []
    closures = data.get("closures") or []

    def _already_queued(question: str, task_ids: list[str]) -> bool:
        """写入前现查,不吃批处理开头那张快照 —— 两个人各拿一份 json 同时跑时,
        快照式判重会双双认为「不重复」。窗口缩到单条,彻底消除要 DDL 加 UNIQUE。"""
        key = _dup_key(question, task_ids)
        return any(_dup_key(r["question"], r["task_ids"]) == key for r in db.open_asks(path))

    new = [p for p in proposals if not _already_queued(p["question"], p["task_ids"])]
    dup = len(proposals) - len(new)

    failed: list[tuple[str, str, str]] = []
    tag = "真写" if a.apply else "dry-run(加 --apply 才写)"
    print(f"库:{path}\n{tag} · 新提 {len(new)} 条(去重掉 {dup} 条已在队列里的)· "
          f"清理 {len(closures)} 条\n")

    for p in sorted(new, key=lambda x: -(0.5 if x.get("confidence") is None
                                         else x["confidence"])):
        c = p.get("confidence")
        since = _waiting_from_cards(path, p["task_ids"])
        print(f"  [{p['kind']}] {'?' if c is None else format(c, '.0%')}  {p['question']}")
        print(f"      挂 {len(p['task_ids'])} 张 · {p.get('confidence_reason', '')[:70]}")
        if a.apply:
            if _already_queued(p["question"], p["task_ids"]):
                print("      ↷ 跳过:刚刚已经有人提了同一件事")
                continue
            try:
                aid = db.raise_ask(
                    path, kind=p["kind"], question=p["question"], evidence=p["evidence"],
                    task_ids=p["task_ids"], raised_by=RAISED_BY, raised_at=since,
                    options=p.get("options"), blast=p.get("blast"),
                    hands_on=bool(p.get("hands_on")),
                    confidence=c, confidence_reason=p.get("confidence_reason"))
            except (db.WorkosError, sqlite3.IntegrityError) as e:
                # 只吞「这一条数据不合法」:业务闸 + DDL 约束。故意不吞 OperationalError
                # (锁超时/磁盘 IO/库损坏)—— 那是环境坏了,该整个停下来,不是逐条记账继续跑。
                failed.append(("提", p["question"], str(e)))
                print(f"      ✗ 没提成:{e}")
                continue
            print(f"      → ask #{aid}")

    for c in closures:
        aid = int(c["ask_id"])
        how = "task_closed" if _all_done(path, aid) else "withdrawn"
        print(f"  ✕ 关 ask #{aid}({how}): {c['reason'][:70]}")
        if a.apply:
            try:
                db.close_ask(path, aid, closed_as=how, answer=f"巡检:{c['reason']}")
            except (db.WorkosError, sqlite3.IntegrityError) as e:
                # 最常见:人已经在板上答过它了(close_ask 对已关的 ask 会抛)。
                # 同样不吞 OperationalError,理由见上。
                failed.append(("关", f"#{aid}", str(e)))
                print(f"      ✗ 没关成:{e}")

    if not a.apply and (new or closures):
        print("\n看着对 → 同样命令加 --apply")
    if failed:
        print(f"\n{len(failed)} 条没成(其余已落):")
        for what, who, why in failed:
            print(f"  ✗ {what} {who[:40]} —— {why[:80]}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
