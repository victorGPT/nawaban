"""Legacy cards remain discoverable and can receive an audited project."""
import os
import sqlite3
import subprocess
import sys

import pytest

from nawaban import db


@pytest.fixture
def board(tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    for tid, project in [("NULL", None), ("EMPTY", ""), ("NAMED", "demo")]:
        db.create_task(path, task_id=tid, title="Example task", project=project)
        db.raise_ask(path, kind="accept", question=f"Accept {tid}?", evidence="Test result",
                     task_ids=[tid], raised_by="fixture")
    return path


def cli(path, *args):
    return subprocess.run([sys.executable, "-m", "nawaban", "--db", str(path), *args],
                          env=os.environ.copy(), capture_output=True, text=True)


@pytest.mark.parametrize("tid", ["NULL", "EMPTY"])
def test_cli_assigns_empty_project_with_audit_and_rejects_overwrite(board, tid):
    with sqlite3.connect(board) as con:
        schema = con.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall()
    result = cli(board, "meta", tid, "--set-project", "demo")
    assert result.returncode == 0, result.stderr
    for value in ("demo", "other"):
        result = cli(board, "meta", tid, "--set-project", value)
        assert result.returncode != 0
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT project FROM tasks WHERE id=?", (tid,)).fetchone() == ("demo",)
        events = con.execute("SELECT body,author,session_id FROM task_events WHERE task_id=? AND body LIKE 'meta %'", (tid,)).fetchall()
        assert events == [("meta 补填:project=demo", "ac:selftest", "selftest-session")]
        assert con.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall() == schema


def test_meta_conflict_is_atomic_and_blank_project_is_rejected(board):
    result = cli(board, "meta", "NAMED", "--set-project", "other", "--set-epic", "EXAMPLE")
    assert result.returncode != 0
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT epic,project FROM tasks WHERE id='NAMED'").fetchone() == (None, "demo")
    assert cli(board, "meta", "NULL", "--set-project", "   ").returncode != 0
