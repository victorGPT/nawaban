"""Canonical verbs and context preserve existing board data and CLI behavior."""

import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import board_view, cli, context_loader, db  # noqa: E402


@pytest.fixture
def board(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="T", title="用户能看到任务背景", context="背景\n原文")
    monkeypatch.setenv("FOREMAN_OWNER", "test")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "test-session")
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    return path


def test_legacy_column_migrates_losslessly_and_only_once(board):
    with sqlite3.connect(board) as con:
        con.execute("ALTER TABLE tasks RENAME COLUMN context TO origin")
        con.executemany("INSERT INTO tasks(id,title,origin,created_at) VALUES(?,?,?,0)",
                        [("EMPTY", "Empty", ""), ("NULL", "Null", None)])
        before = con.execute("SELECT id,origin FROM tasks ORDER BY id").fetchall()
    assert db.migrate_db(board) == ["tasks.origin→context"]
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT id,context FROM tasks ORDER BY id").fetchall() == before
        assert "origin" not in {r[1] for r in con.execute("PRAGMA table_info(tasks)")}
        first = list(con.iterdump())
    assert db.migrate_db(board) == []
    with sqlite3.connect(board) as con:
        assert list(con.iterdump()) == first


@pytest.mark.parametrize("option", ["--context", "--origin", "--context-file", "--origin-file"])
def test_create_context_options_write_context(board, tmp_path, option):
    text = "原文\nSecond line\n"
    value = text
    if option.endswith("-file"):
        source = tmp_path / "context.md"
        source.write_text(text)
        value = str(source)
    assert cli.main(["--db", str(board), "create", "NEW", "--title", "用户能看到背景",
                     option, value]) == 0
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT context FROM tasks WHERE id='NEW'").fetchone() == (text,)


@pytest.mark.parametrize("direct,file", [("--context", "--origin-file"),
                                        ("--origin", "--context-file")])
def test_context_and_file_conflict_across_aliases(board, direct, file):
    assert cli.main(["--db", str(board), "create", "NEW", "--title", "用户能看到背景",
                     direct, "text", file, "unused"]) == 1
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT count(*) FROM tasks WHERE id='NEW'").fetchone() == (0,)


@pytest.mark.parametrize("old,new,args", [
    ("kin", "deps", ["T"]),
    ("advance", "transition", ["T", "--to", "staging-verified", "--waiting-on", "observe"]),
    ("letter", "notify", ["T", "--kind", "stage", "--msg", "Observed result"]),
    ("letters", "notifications", ["--task", "T"]),
    ("letter-read", "notify-read", ["1"]),
])
def test_aliases_have_identical_output_and_effects(board, tmp_path, monkeypatch, capsys,
                                                  old, new, args):
    monkeypatch.setattr(db, "_now", lambda: 1700000000)
    db.claim_task(board, "T", owner="test", session_id="test-session")
    db.start_task(board, "T", owner="test", session_id="test-session", now="Checking")
    db.add_ref(board, "T", kind="acceptance_run", value="test://observed")
    db.add_letter(board, "T", kind="stage", msg="Existing", session_id="test-session")
    snapshot = tmp_path / "snapshot.db"
    with sqlite3.connect(board) as source, sqlite3.connect(snapshot) as dest:
        source.backup(dest)
    results = []
    states = []
    for verb in (old, new):
        # Restore the same board path so writes see exactly the same starting state.
        with sqlite3.connect(snapshot) as source, sqlite3.connect(board) as dest:
            source.backup(dest)
        assert cli.main(["--db", str(board), verb, *args]) == 0
        results.append(capsys.readouterr())
        with sqlite3.connect(board) as con:
            states.append(list(con.iterdump()))
    assert results[0] == results[1]
    assert states[0] == states[1]


def test_help_only_lists_canonical_verbs(capsys):
    with pytest.raises(SystemExit) as result:
        cli.main(["--help"])
    assert result.value.code == 0
    text = capsys.readouterr().out
    for name in ("kin", "advance", "letter", "letters", "letter-read"):
        assert name not in text
    for name in ("deps", "transition", "notify", "notifications", "notify-read", "fanout", "wrapup"):
        assert name in text


def test_board_and_loader_read_context(board):
    detail = board_view.task_detail(board, "T")
    assert detail["context"] == "背景\n原文"
    assert "origin" not in detail
    graph = board_view.graph_data(board)
    assert graph["nodes"][0]["context"] == detail["context"]
    assert "origin" not in graph["nodes"][0]
    assert detail["context"] in context_loader.build_context(board, "T", lens_k=0)


def test_imported_task_context_reaches_board(board):
    assert db.import_task(board, task_id="IMPORTED", title="Imported task", status="open",
                          created_at=1, context="Original import text")
    assert board_view.task_detail(board, "IMPORTED")["context"] == "Original import text"
