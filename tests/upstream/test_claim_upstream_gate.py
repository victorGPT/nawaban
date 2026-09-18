#!/usr/bin/env python3
"""board revamp wf claimgate impl regression · claim 上游闸回归自检 · 零依赖(不需 pytest)。

跑法:python3 tests/upstream/test_claim_upstream_gate.py → 全绿 OK / 任一失败 exit 1。
覆盖(对照卡 success):上游未 done 被拒且报错列上游 · 上游全 done 可 claim ·
override 放行且留 coord 审计事件 · 无边卡行为不变。
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import db  # noqa: E402

OWNER, SID = "ac:test", "sess-test"


def _mk(p: Path, tid: str) -> None:
    db.create_task(p, task_id=tid, title=f"{tid} 测试卡", context="claim 闸测试")


def _done(p: Path, tid: str) -> None:
    assert db.claim_task(p, tid, owner=OWNER, session_id=SID)
    db.start_task(p, tid, owner=OWNER, session_id=SID)
    db.add_event(p, tid, kind="acceptance", body="测试:验收正文", author=OWNER, session_id=SID)
    db.add_ref(p, tid, kind="acceptance_run", value="test://run")
    db.advance_task(p, tid, to="staging-verified", waiting_on="prod", owner=OWNER, session_id=SID)
    db.advance_task(p, tid, to="done", owner=OWNER, session_id=SID)


def main() -> int:
    tmp = Path(tempfile.mkdtemp()) / "gate.db"
    db.init_db(tmp)
    for t in ("UP-001", "DOWN-001", "FREE-001", "REL-B-001"):
        _mk(tmp, t)
    db.link_tasks(tmp, "DOWN-001", "UP-001", kind="depends_on", created_by=OWNER)

    # ① 上游未 done → 拒,报错点名上游
    try:
        db.claim_task(tmp, "DOWN-001", owner=OWNER, session_id=SID)
        raise AssertionError("上游未 done 竟然 claim 成功")
    except db.NawabanError as e:
        assert "UP-001" in str(e) and "上游" in str(e), f"报错没点名上游:{e}"

    # ② 无边卡不受影响
    assert db.claim_task(tmp, "FREE-001", owner=OWNER, session_id=SID), "无边卡不该挡"

    # ③ override 放行且留 coord 审计事件
    assert db.claim_task(tmp, "DOWN-001", owner="ac:other", session_id=SID,
                         override="紧急 hotfix,上游不阻塞本改动"), "override 该放行"
    import sqlite3
    con = sqlite3.connect(tmp)
    n = con.execute("SELECT count(*) FROM task_events WHERE task_id='DOWN-001'"
                    " AND kind='coord' AND body LIKE '%越上游闸%UP-001%'").fetchone()[0]
    con.close()
    assert n == 1, "override 没留 coord 审计事件"

    # ④ 上游全 done → 正常 claim(新下游卡验证,避免与 ③ 的占用纠缠)
    _mk(tmp, "DOWN-002")
    db.link_tasks(tmp, "DOWN-002", "REL-B-001", kind="depends_on", created_by=OWNER)
    _done(tmp, "REL-B-001")
    assert db.claim_task(tmp, "DOWN-002", owner=OWNER, session_id=SID), "上游全 done 该放行"

    print("OK · claim 上游闸 4 项全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
