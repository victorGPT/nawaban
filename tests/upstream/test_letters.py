#!/usr/bin/env python3
"""WORKOS-LETTERS-DB-001 · letters 表回归自检 · 零依赖。

跑法:python3 tests/upstream/test_letters.py → OK / exit 1。
覆盖:写信落库 · kind/msg/卡存在三闸 · unread 过滤 · 标已读幂等 · migrate_db 老库补表。
"""
from __future__ import annotations
import os
import sys
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))
from nawaban import db  # noqa: E402


def main() -> int:
    tmp = Path(tempfile.mkdtemp()) / "lt.db"
    db.init_db(tmp)
    db.create_task(tmp, task_id="T-L-001", title="测试卡", context="letters 测试")

    lid = db.add_letter(tmp, "T-L-001", kind="done", msg="活干完了", session_id="s1")
    assert lid == 1

    for kw, why in (({"kind": "weird", "msg": "x"}, "非法 kind"),
                    ({"kind": "done", "msg": "  "}, "空 msg")):
        try:
            db.add_letter(tmp, "T-L-001", **kw)
            raise AssertionError(f"应拒:{why}")
        except db.NawabanError:
            pass
    try:
        db.add_letter(tmp, "T-NOPE-001", kind="done", msg="幻觉卡")
        raise AssertionError("卡不存在应拒")
    except db.NawabanError:
        pass

    db.add_letter(tmp, "T-L-001", kind="blocked", msg="卡住了")
    assert len(db.list_letters(tmp, unread_only=True)) == 2
    assert db.mark_letters_read(tmp, [lid]) == 1
    assert db.mark_letters_read(tmp, [lid]) == 0, "标已读须幂等"
    assert len(db.list_letters(tmp, unread_only=True)) == 1
    assert len(db.list_letters(tmp, task_id="T-L-001")) == 2

    # 老库(无 letters 表)经 migrate_db 补表
    import sqlite3
    old = Path(tempfile.mkdtemp()) / "old.db"
    db.init_db(old)
    con = sqlite3.connect(old)
    con.execute("DROP TABLE letters"); con.commit(); con.close()
    assert "letters" in db.migrate_db(old)
    db.create_task(old, task_id="T-L-002", title="老库卡", context="x")
    db.add_letter(old, "T-L-002", kind="claim", msg="老库也能写")

    print("OK · letters 8 项全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
