#!/usr/bin/env python3
"""BOARD-REVAMP-WF-HANDOFF-GATE-001 · handoff completed 闸自检 · 零依赖。

跑法:python3 tests/upstream/test_handoff_completed_gate.py → OK / exit 1。
覆盖:completed 且卡未翻牌 → 拒且零写入;handed_off/blocked 不受限;
completed 且卡已 staging-verified → 放行。
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import db  # noqa: E402

OWNER = "ac:test"


def _mk(p: Path, tid: str, sid: str) -> None:
    db.create_task(p, task_id=tid, title=f"{tid} 测试卡", context="handoff 闸测试")
    assert db.claim_task(p, tid, owner=OWNER, session_id=sid)
    db.start_task(p, tid, owner=OWNER, session_id=sid)


def main() -> int:
    tmp = Path(tempfile.mkdtemp()) / "hg.db"
    db.init_db(tmp)

    # ① completed 且卡在 in_progress → 拒,且三件套零写入
    _mk(tmp, "T-A-001", "s-a")
    try:
        db.handoff(tmp, "T-A-001", owner=OWNER, session_id="s-a",
                   outcome="completed", summary="想跳过翻牌", now="x")
        raise AssertionError("completed 未翻牌竟然过了")
    except db.NawabanError as e:
        assert "handoff 闸" in str(e) and "in_progress" in str(e), e
    con = sqlite3.connect(tmp)
    ended = con.execute("SELECT ended_at FROM task_sessions WHERE session_id='s-a'").fetchone()[0]
    ev = con.execute("SELECT count(*) FROM task_events WHERE kind='handoff'").fetchone()[0]
    con.close()
    assert ended is None and ev == 0, "拒收尾必须零写入"

    # ② handed_off 不受限
    db.handoff(tmp, "T-A-001", owner=OWNER, session_id="s-a",
               outcome="handed_off", summary="如实交接", now="交接中")

    # ③ completed 且已翻牌(staging-verified)→ 放行
    _mk(tmp, "T-B-001", "s-b")
    db.add_event(tmp, "T-B-001", kind="acceptance", body="测试:验收正文",
                 author=OWNER, session_id="s-b")
    db.add_ref(tmp, "T-B-001", kind="acceptance_run", value="test://run")
    db.advance_task(tmp, "T-B-001", to="staging-verified", waiting_on="prod",
                    owner=OWNER, session_id="s-b")
    db.handoff(tmp, "T-B-001", owner=OWNER, session_id="s-b",
               outcome="completed", summary="翻牌后收尾", now="等归档")

    print("OK · handoff completed 闸 3 项全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
