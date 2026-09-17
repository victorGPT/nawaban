"""Exercise inbox workflows through their public interface and real SQLite."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from nawaban import db, inbox


class InboxContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="workos-inbox-interface-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "workos.db"
        self.owner = "ac:interface"
        self.session = "interface-session"
        self.identity = {"owner": self.owner, "session_id": self.session}
        self.environment = patch.dict(os.environ, {}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop("WORKOS_DECISION_CHANNEL", None)
        clock = patch("time.time", return_value=1000)
        self.clock = clock.start()
        self.addCleanup(clock.stop)
        db.init_db(self.path)

    def seed(self, *task_ids):
        for task_id in task_ids:
            db.create_task(self.path, task_id=task_id, title="页面可打开", context="interface test")
            db.claim_task(self.path, task_id, **self.identity)
            db.start_task(self.path, task_id, **self.identity)
            db.add_ref(self.path, task_id, kind="acceptance_run", value="observed local run")

    def ask(self, kind="accept", task_ids=("T-A",), **kwargs):
        return inbox.raise_ask(self.path, kind=kind, question="结果可以接受吗？",
                               evidence="真机操作记录", task_ids=task_ids,
                               raised_by=self.owner, **kwargs)

    def verify(self, *task_ids):
        for task_id in task_ids:
            db.advance_task(self.path, task_id, to="staging-verified",
                            waiting_on="decision", **self.identity)
        self.clock.return_value = 1001

    def rows(self, sql):
        with closing(sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)) as con:
            return con.execute(sql).fetchall()

    def test_material_rejections_write_nothing(self):
        self.seed("T-A")
        cases = [
            {"kind": "accept", "evidence": "CI 全绿，已部署"},
            {"kind": "authorize", "blast": None},
            {"kind": "authorize", "blast": "员工|改页面"},
            {"kind": "decide", "options": ["继续|完成原计划"]},
            {"kind": "decide", "options": ["继续|完成原计划", "暂停|"]},
        ]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(db.NawabanError):
                inbox.raise_ask(self.path, question="继续吗？", task_ids=["T-A"],
                                raised_by=self.owner,
                                **{"evidence": "真机实测", **values})
            self.assertEqual(db.open_asks(self.path), [])
        self.assertEqual(self.rows("SELECT count(*) FROM ask_tasks"), [(0,)])

    def test_materials_are_normalized_and_readable(self):
        self.seed("T-A", "T-B")
        aid = self.ask(kind="decide", task_ids=["T-B", "T-A", "T-A"],
                       options=[" 继续 | 保留功能|承担维护 ", " 暂停 | 推迟交付 "],
                       hands_on=True)
        detail = db.ask_detail(self.path, aid)
        self.assertEqual(detail["options"], [
            {"option": "继续", "consequence": "保留功能|承担维护"},
            {"option": "暂停", "consequence": "推迟交付"},
        ])
        self.assertEqual([t["id"] for t in detail["tasks"]], ["T-A", "T-B"])
        self.assertTrue(detail["hands_on"])
        aid = self.ask(kind="authorize", blast=" 员工 | 更新页面 | 回退版本 ")
        self.assertEqual(db.ask_detail(self.path, aid)["blast"],
                         {"who": "员工", "what": "更新页面", "rollback": "回退版本"})

    def test_answer_acceptance_records_user_decisions_and_closes_last(self):
        self.seed("T-A", "T-B")
        aid = self.ask(task_ids=["T-B", "T-A"])
        self.verify("T-A", "T-B")
        result = inbox.answer_ask(self.path, aid, verdict="接受", **self.identity)
        self.assertEqual(result, inbox.AnswerResult(kind="accept", task_ids=("T-A", "T-B")))
        self.assertEqual(self.rows("SELECT status FROM tasks ORDER BY id"), [("done",), ("done",)])
        self.assertEqual(self.rows("SELECT decided_by,verdict FROM task_decisions"),
                         [("user", "接受"), ("user", "接受")])
        self.assertEqual(db.ask_detail(self.path, aid)["closed_as"], "answered")
        with self.assertRaisesRegex(db.NawabanError, "不可重复回答"):
            inbox.answer_ask(self.path, aid, verdict="再次接受", **self.identity)
        self.assertEqual(self.rows("SELECT count(*) FROM task_decisions"), [(2,)])

    def test_rejection_returns_acceptance_to_work(self):
        self.seed("T-A")
        aid = self.ask()
        self.verify("T-A")
        inbox.answer_ask(self.path, aid, verdict="调整文案", reject=True, **self.identity)
        self.assertEqual(self.rows("SELECT status FROM tasks"), [("in_progress",)])
        self.assertIsNotNone(db.ask_detail(self.path, aid)["closed_at"])

    def test_authorization_and_failed_execution_do_not_complete_tasks(self):
        self.seed("T-A", "T-B")
        aid = self.ask(kind="authorize", task_ids=["T-A", "T-B"], blast="员工|更新页面|回退版本")
        self.verify("T-A", "T-B")
        with self.assertRaisesRegex(db.NawabanError, "先 answer"):
            inbox.fanout(self.path, aid, succeeded=True, **self.identity)
        result = inbox.answer_ask(self.path, aid, verdict="允许更新", **self.identity)
        self.assertEqual(result.kind, "authorize")
        self.assertEqual(inbox.fanout(self.path, aid, succeeded=False, **self.identity), ("T-A", "T-B"))
        self.assertEqual(self.rows("SELECT status FROM tasks"),
                         [("staging-verified",), ("staging-verified",)])
        self.assertEqual(self.rows("SELECT count(*) FROM task_decisions"), [(2,)])
        self.assertEqual(self.rows("SELECT task_id FROM task_events WHERE body LIKE '%执行失败%'"),
                         [("T-A",)])
        self.assertEqual(inbox.fanout(self.path, aid, succeeded=True, **self.identity), ("T-A", "T-B"))
        self.assertEqual(self.rows("SELECT status FROM tasks"), [("done",), ("done",)])

    def test_decide_answer_records_rejected_choices_without_moving_tasks(self):
        self.seed("T-A")
        aid = self.ask(kind="decide", options=["继续|保留交付", "暂停|延后交付"])
        rejected = [{"option": "暂停", "reason": "仍需要交付"}]
        result = inbox.answer_ask(self.path, aid, verdict="继续", rejected=rejected, **self.identity)
        self.assertEqual(result.kind, "decide")
        self.assertEqual(self.rows("SELECT status FROM tasks"), [("in_progress",)])
        self.assertEqual(json.loads(self.rows("SELECT rejected FROM task_decisions")[0][0]), rejected)

    def test_same_second_gate_leaves_ask_open_with_decision_recorded(self):
        self.seed("T-A")
        aid = self.ask()
        self.verify("T-A")
        self.clock.return_value = 1000
        with self.assertRaises(db.NawabanError):
            inbox.answer_ask(self.path, aid, verdict="接受", **self.identity)
        self.assertIsNone(db.ask_detail(self.path, aid)["closed_at"])
        self.assertEqual(self.rows("SELECT status FROM tasks"), [("staging-verified",)])
        self.assertEqual(self.rows("SELECT count(*) FROM task_decisions"), [(1,)])

    def test_later_task_failure_preserves_earlier_commits(self):
        self.seed("T-A", "T-B")
        aid = self.ask(task_ids=["T-A", "T-B"])
        self.verify("T-A")
        with self.assertRaises(db.NawabanError):
            inbox.answer_ask(self.path, aid, verdict="接受", **self.identity)
        self.assertEqual(self.rows("SELECT status FROM tasks ORDER BY id"),
                         [("done",), ("in_progress",)])
        self.assertEqual(self.rows("SELECT count(*) FROM task_decisions"), [(2,)])
        self.assertIsNone(db.ask_detail(self.path, aid)["closed_at"])

    def test_fanout_failure_preserves_closed_ask_and_earlier_transitions(self):
        self.seed("T-A", "T-B")
        aid = self.ask(kind="authorize", task_ids=["T-A", "T-B"], blast="员工|更新页面|回退版本")
        self.verify("T-A")
        inbox.answer_ask(self.path, aid, verdict="允许更新", **self.identity)
        with self.assertRaises(db.NawabanError):
            inbox.fanout(self.path, aid, succeeded=True, **self.identity)
        self.assertEqual(self.rows("SELECT status FROM tasks ORDER BY id"),
                         [("done",), ("in_progress",)])
        self.assertEqual(self.rows("SELECT count(*) FROM task_decisions"), [(4,)])
        self.assertEqual(db.ask_detail(self.path, aid)["closed_as"], "answered")

    def test_answer_records_runtime_actor_without_reassigning_task(self):
        self.seed("T-A")
        aid = self.ask()
        self.verify("T-A")
        inbox.answer_ask(self.path, aid, verdict="接受", owner="ac:other",
                         session_id="other-session")
        self.assertEqual(self.rows("SELECT status,owner FROM tasks"), [("done", self.owner)])
        self.assertEqual(self.rows("SELECT author,session_id FROM task_events ORDER BY id DESC LIMIT 1"),
                         [("ac:other", "other-session")])

    def test_cli_rejects_missing_session_before_recording_answer(self):
        self.seed("T-A")
        aid = self.ask()
        env = dict(os.environ, FOREMAN_OWNER=self.owner)
        env.pop("CLAUDE_CODE_SESSION_ID", None)
        result = subprocess.run(
            [sys.executable, "-m", "nawaban", "--db", str(self.path),
             "answer", str(aid), "--verdict", "接受"],
            env=env, capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("身份缺失", result.stderr)
        self.assertEqual(self.rows("SELECT count(*) FROM task_decisions"), [(0,)])
        self.assertIsNone(db.ask_detail(self.path, aid)["closed_at"])


if __name__ == "__main__":
    unittest.main()
