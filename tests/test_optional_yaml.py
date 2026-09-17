"""Optional Markdown parsing must not prevent database runtime imports."""

import builtins
import sqlite3

import pytest

from nawaban import db, foreman_card


def test_missing_yaml_fails_closed_at_markdown_boundary(monkeypatch):
    original_import = builtins.__import__

    def without_yaml(name, *args, **kwargs):
        if name == "yaml":
            raise ModuleNotFoundError("No module named 'yaml'", name="yaml")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_yaml)
    assert foreman_card.touches_match("src/example.py", "src/")
    with pytest.raises(foreman_card.CardError, match="optional PyYAML"):
        foreman_card.parse_card_text("---\ntask_id: DEMO\ntouches: []\n---\n")


def test_import_provenance_migration_needs_no_markdown_parser(tmp_path):
    board = tmp_path / "board.db"
    db.init_db(board)
    with sqlite3.connect(board) as con:
        con.execute("ALTER TABLE task_decisions DROP COLUMN provenance")
    assert db.migrate_db(board) == ["task_decisions.provenance"]
    assert db.migrate_db(board) == []
