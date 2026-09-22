"""The owner comes from NAWABAN_OWNER; the old FOREMAN_OWNER keeps working."""

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import cli, db  # noqa: E402


@pytest.mark.parametrize("new,old,expected", [
    ("new-name", None, "new-name"),
    (None, "old-name", "old-name"),
    ("new-name", "old-name", "new-name"),
    (None, None, None),
])
def test_owner_prefers_new_name_and_falls_back_to_old(monkeypatch, new, old, expected):
    for name, value in (("NAWABAN_OWNER", new), ("FOREMAN_OWNER", old)):
        monkeypatch.delenv(name, raising=False)
        if value:
            monkeypatch.setenv(name, value)
    assert db.owner_from_env() == expected


@pytest.mark.parametrize("name", ["NAWABAN_OWNER", "FOREMAN_OWNER"])
def test_claim_records_the_owner_from_either_name(tmp_path, monkeypatch, name):
    board = tmp_path / "board.db"
    db.init_db(board)
    db.create_task(board, task_id="T", title="用户能看到负责人")
    monkeypatch.delenv("NAWABAN_OWNER", raising=False)
    monkeypatch.delenv("FOREMAN_OWNER", raising=False)
    monkeypatch.setenv(name, "only-this-name")
    assert cli.main(["--db", str(board), "claim", "T"]) == 0
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT owner FROM tasks WHERE id='T'").fetchone() == ("only-this-name",)
