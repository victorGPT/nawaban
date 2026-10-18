"""workos project regression:卡按项目归属。"""

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


class ProjectFilterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="workos-project-")
        self.addCleanup(self.tmp.cleanup)
        board = Path(self.tmp.name) / "sample-project" / ".foreman"
        board.mkdir(parents=True)
        self.path = board / "workos.db"
        db.init_db(self.path)

    def _mk(self, tid, project):
        db.create_task(self.path, task_id=tid, title="页面可打开", project=project)

    def _project(self, tid):
        with closing(sqlite3.connect(self.path)) as con:
            return con.execute("SELECT project FROM tasks WHERE id=?", (tid,)).fetchone()[0]

    def _cli(self, *args):
        env = {**os.environ, "NAWABAN_OWNER": "ac:fixture"}
        return subprocess.run(
            [sys.executable, "-m", "nawaban", "--db", str(self.path), "create", *args],
            capture_output=True, text=True, check=False, cwd=self.tmp.name, env=env)

    def test_cli_defaults_to_board_directory_name(self):
        r = self._cli("A", "--title", "页面可打开")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self._project("A"), "sample-project")

    def test_cli_project_flag_overrides_default(self):
        r = self._cli("A", "--title", "页面可打开", "--project", "workos")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self._project("A"), "workos")

    def test_split_card_inherits_parent_project(self):
        self._mk("PARENT", "workos")
        r = self._cli("CHILD", "--title", "页面可打开", "--split-from", "PARENT")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self._project("CHILD"), "workos")

    def test_migrate_adds_project_column_once(self):
        with closing(sqlite3.connect(self.path)) as con:
            con.execute("ALTER TABLE tasks DROP COLUMN project")
        self.assertIn("tasks.project", db.migrate_db(self.path))
        self.assertEqual(db.migrate_db(self.path), [])


if __name__ == "__main__":
    unittest.main()
