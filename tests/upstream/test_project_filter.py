"""WORKOS-PROJECT-001:卡按项目归属,看板/模块/收件箱可按项目收窄。"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from nawaban import board_view as bv
from nawaban import db, inbox


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
        env = {**os.environ, "FOREMAN_OWNER": "ac:fixture"}
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

    def test_board_reads_unmigrated_database(self):
        self._mk("A", "sample-project")
        with closing(sqlite3.connect(self.path)) as con:
            con.execute("ALTER TABLE tasks DROP COLUMN project")
        ids = {t["id"] for c in bv.board_data(self.path)["columns"] for t in c["tasks"]}
        self.assertEqual(ids, {"A"})
        self.assertEqual(bv.task_detail(self.path, "A")["project"], None)
        self.assertEqual(bv.projects_data(self.path)["projects"][0]["name"], None)
        self.assertEqual(bv.modules_data(self.path, project="sample-project")["tasks"], [])

    def test_board_and_modules_show_only_selected_project(self):
        self._mk("AC", "sample-project")
        self._mk("WO", "workos")
        self._mk("WO2", "workos")
        db.link_tasks(self.path, "WO2", "WO", kind="depends_on", created_by="ac:fixture")
        db.link_tasks(self.path, "AC", "WO", kind="depends_on", created_by="ac:fixture")
        board = bv.board_data(self.path, project="workos")
        ids = {t["id"] for c in board["columns"] for t in c["tasks"]}
        self.assertEqual(ids, {"WO", "WO2"})
        mods = bv.modules_data(self.path, project="sample-project")
        self.assertEqual([t["i"] for t in mods["tasks"]], ["AC"])
        self.assertEqual(mods["deps"], [])
        self.assertEqual(bv.modules_data(self.path, project="workos")["deps"], [["WO2", "WO"]])
        self.assertEqual(len(bv.modules_data(self.path)["tasks"]), 3)

    def test_projects_lists_counts_with_unassigned_last(self):
        self._mk("AC", "sample-project")
        self._mk("NONE", None)
        names = [p["name"] for p in bv.projects_data(self.path)["projects"]]
        self.assertEqual(names, ["sample-project", None])

    def test_inbox_keeps_questions_linked_to_project(self):
        self._mk("AC", "sample-project")
        self._mk("WO", "workos")
        for tid in ("AC", "WO"):
            db.raise_ask(self.path, kind="accept", question=f"验收 {tid} 吗？",
                         evidence="真机实测记录", task_ids=[tid], raised_by="ac:fixture")
        data = bv.project_inbox(self.path, inbox.read(self.path), "workos")
        self.assertEqual(data["total"], 1)
        self.assertEqual([a["task_ids"] for g in data["groups"] for a in g["items"]], [["WO"]])
        self.assertEqual(bv.project_inbox(self.path, inbox.read(self.path), None)["total"], 2)


if __name__ == "__main__":
    unittest.main()
