"""workos origin gate regression:建卡来由必须是无序列表。"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from nawaban import db
from nawaban.task_content import context_problem


class OriginGateTests(unittest.TestCase):
    def test_bullet_lines_with_blank_and_nested_items_pass(self):
        self.assertIsNone(context_problem("- **用户**:要做\n\n- **背景**:原因\n  - 子项\n* 星号也算"))

    def test_absent_origin_passes(self):
        self.assertIsNone(context_problem(None))
        self.assertIsNone(context_problem("  \n"))

    def test_prose_or_numbered_lines_are_rejected(self):
        for text in ("用户说要做这个", "- 要点\n续写的散文行", "1. 编号列表", "-没有空格"):
            with self.subTest(text=text):
                self.assertIn("无序列表", context_problem(text))

    def test_cli_refuses_prose_origin_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "workos.db"
            db.init_db(path)
            env = {**os.environ, "NAWABAN_OWNER": "ac:fixture"}

            def create(tid, context):
                return subprocess.run(
                    [sys.executable, "-m", "nawaban", "--db", str(path), "create", tid,
                     "--title", "页面可打开", "--context", context],
                    capture_output=True, text=True, check=False, cwd=tmp, env=env)

            bad = create("BAD", "一段散文来由")
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn("无序列表", bad.stderr)
            self.assertEqual(create("GOOD", "- **背景**:原因").returncode, 0, bad.stderr)
            with closing(sqlite3.connect(path)) as con:
                self.assertEqual([r[0] for r in con.execute("SELECT id FROM tasks")], ["GOOD"])


if __name__ == "__main__":
    unittest.main()
