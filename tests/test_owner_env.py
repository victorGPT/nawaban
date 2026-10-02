"""The owner comes from NAWABAN_OWNER only; the retired FOREMAN_OWNER is ignored."""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import cli, db  # noqa: E402


def test_owner_comes_from_nawaban_owner(monkeypatch):
    monkeypatch.setenv("NAWABAN_OWNER", "new-name")
    monkeypatch.setenv("FOREMAN_OWNER", "old-name")
    assert db.owner_from_env() == "new-name"


def test_retired_owner_variable_is_ignored(monkeypatch):
    monkeypatch.delenv("NAWABAN_OWNER", raising=False)
    monkeypatch.setenv("FOREMAN_OWNER", "old-name")
    assert db.owner_from_env() is None


def test_claim_records_the_owner(tmp_path, monkeypatch):
    board = tmp_path / "board.db"
    db.init_db(board)
    db.create_task(board, task_id="T", title="用户能看到负责人")
    monkeypatch.setenv("NAWABAN_OWNER", "only-this-name")
    assert cli.main(["--db", str(board), "claim", "T"]) == 0
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT owner FROM tasks WHERE id='T'").fetchone() == ("only-this-name",)
