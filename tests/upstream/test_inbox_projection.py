"""Shared inbox behavior through the domain interface, CLI, and served Web API."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from nawaban import db, inbox

NOW = 2_000_000_000
DAY = 86400


class InboxProjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="workos-inbox-read-")
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "selected.sqlite"
        clock = patch("time.time", return_value=NOW)
        self.clock = clock.start()
        self.addCleanup(clock.stop)
        db.init_db(self.path)

    def _ask(self, task_id, kind="accept", age=0, confidence=None):
        db.create_task(self.path, task_id=task_id, title="页面可打开")
        return db.raise_ask(
            self.path, kind=kind, question=f"处理 {task_id} 吗？", evidence="真机实测记录",
            task_ids=[task_id], raised_by="ac:fixture", raised_at=NOW-age*DAY,
            confidence=confidence, confidence_reason="记录完整" if confidence is not None else None)

    def _cli(self, *args):
        code = (
            "import sys, time; time.time = lambda: 2000000000; "
            "sys.modules['nawaban.board_view'] = None; "
            "from nawaban.cli import main; raise SystemExit(main(sys.argv[1:]))"
        )
        return subprocess.run(
            [sys.executable, "-c", code, "--db", str(self.path), *args],
            capture_output=True, text=True, check=False)

    def test_group_order_confidence_and_age_preserve_every_question(self):
        self._ask("AUTHORIZE", kind="authorize")
        self._ask("SURE", age=1, confidence=0.9)
        self._ask("NEUTRAL")
        self._ask("UNSURE", age=3, confidence=0.0)
        self._ask("DECIDE", kind="decide", age=5)
        data = inbox.read(self.path)
        self.assertEqual([g["kind"] for g in data["groups"]], ["authorize", "accept", "decide"])
        items = data["groups"][1]["items"]
        self.assertEqual([item["task_ids"] for item in items], [["SURE"], ["NEUTRAL"], ["UNSURE"]])
        self.assertEqual(items[-1]["confidence"], 0.0)
        self.assertEqual(items[-1]["stalled_days"], 3.0)
        self.assertEqual((data["total"], data["oldest_days"]), (5, 5.0))

    def test_flow_excludes_exact_seven_day_boundary_and_closed_asks(self):
        old = self._ask("OLD", age=10)
        self.clock.return_value = NOW-7*DAY
        db.close_ask(self.path, old, closed_as="withdrawn")
        self.clock.return_value = NOW
        recent = self._ask("CLOSED", age=1)
        db.close_ask(self.path, recent, closed_as="answered", answer="允许")
        self._ask("BOUNDARY", age=7)
        self._ask("OPEN")
        data = inbox.read(self.path)
        self.assertEqual(data["flow"], {"raised_7d": 2, "closed_7d": 1})
        self.assertEqual(data["total"], 2)
        self.assertEqual(data["oldest_days"], 7.0)
        self.assertEqual(data["agent_side"], 2)

    def test_agent_side_counts_nonterminal_tasks_without_open_asks(self):
        self._ask("WAITING")
        for task_id in ("WORK", "DONE", "CANCELLED"):
            db.create_task(self.path, task_id=task_id, title="待办")
        db.claim_task(self.path, "DONE", owner="ac:fixture", session_id="fixture")
        db.start_task(self.path, "DONE", owner="ac:fixture", session_id="fixture")
        db.add_ref(self.path, "DONE", kind="merge_sha", value="fixture-merge")
        db.advance_task(self.path, "DONE", to="done", owner="ac:fixture", session_id="fixture")
        db.cancel_task(self.path, "CANCELLED", reason="前提消失", owner="ac:fixture", session_id="fixture")
        self.assertEqual(inbox.read(self.path)["agent_side"], 1)

    def test_legacy_database_stays_unmigrated(self):
        legacy = Path(self.tmp.name) / "legacy.sqlite"
        with closing(sqlite3.connect(legacy)) as con:
            con.execute("CREATE TABLE tasks(id TEXT)")
            con.commit()
        before = legacy.read_bytes()
        result = inbox.read(legacy)
        self.assertTrue(result["unavailable"])
        self.assertEqual((result["total"], result["agent_side"]), (0, 0))
        self.assertEqual(result["flow"], {"raised_7d": 0, "closed_7d": 0})
        self.assertEqual(len(result["groups"]), 3)
        self.assertEqual(legacy.read_bytes(), before)

    def test_missing_database_is_not_created(self):
        missing = Path(self.tmp.name) / "missing.sqlite"
        with self.assertRaises(sqlite3.OperationalError):
            inbox.read(missing)
        self.assertFalse(missing.exists())

    def test_read_does_not_write_or_establish_a_decision_channel(self):
        self._ask("QUESTION")
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("WORKOS_DECISION_CHANNEL", None)
            before = self.path.read_bytes()
            inbox.read(self.path)
            self.assertEqual(self.path.read_bytes(), before)
            self.assertNotIn("WORKOS_DECISION_CHANNEL", os.environ)

    def test_cli_queries_and_help_work_without_the_web_module(self):
        self._ask("QUESTION")
        result = self._cli("inbox", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), inbox.read(self.path))
        result = self._cli("inbox")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 件事等你", result.stdout)
        result = self._cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_python_served_build_uses_the_same_projection_and_selected_database(self):
        from nawaban import board_view

        self._ask("QUESTION", age=2)
        decoy = Path(self.tmp.name) / "decoy.sqlite"
        db.init_db(decoy)
        self.assertTrue((board_view.WEBUI_DIST / "index.html").is_file(), "Build web before this test")
        with patch.object(board_view._Handler, "db_path", self.path), \
                patch.dict(os.environ, WORKOS_DB=str(decoy)):
            server = ThreadingHTTPServer(("127.0.0.1", 0), board_view._Handler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urllib.request.urlopen(base + "/?view=inbox", timeout=5) as response:
                    html = response.read().decode()
                self.assertEqual(html, (board_view.WEBUI_DIST / "index.html").read_text())
                assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
                self.assertGreaterEqual(len(assets), 2)
                for asset in assets:
                    with urllib.request.urlopen(base + asset, timeout=5) as response:
                        self.assertTrue(response.read())
                with urllib.request.urlopen(base + "/api/inbox", timeout=5) as response:
                    data = json.load(response)
                self.assertEqual(data, inbox.read(self.path))
                self.assertEqual(data["total"], 1)
                self.assertEqual(inbox.read(decoy)["total"], 0)
                self.assertEqual(board_view.inbox_data(self.path), data)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
