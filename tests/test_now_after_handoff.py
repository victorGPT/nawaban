"""After a handoff the holder can still refresh the board's current state."""

import sqlite3

import pytest

from nawaban import cli, context_loader, db


@pytest.fixture
def board(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="T", title="交接后能刷新当前态")
    monkeypatch.setenv("NAWABAN_OWNER", "worker")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "worker-session")
    for argv in (["claim", "T"], ["start", "T", "--now", "开工"]):
        assert cli.main(["--db", str(path), *argv]) == 0
    return path


def _run(board, *argv):
    return cli.main(["--db", str(board), *argv])


def _now(board):
    with sqlite3.connect(board) as con:
        return con.execute("SELECT now FROM tasks WHERE id='T'").fetchone()[0]


def _handoff(board, now):
    return _run(board, "handoff", "T", "--outcome", "handed_off", "--summary", "交接", "--now", now)


def test_handed_off_card_refreshes_now_with_event_and_handoff_points_there(board, capsys):
    assert _handoff(board, "待 review fb0c688") == 0
    assert _handoff(board, "待 review b2f98ff") == 1
    assert "nawaban event T --body" in capsys.readouterr().err
    assert _now(board) == "待 review fb0c688"

    assert _run(board, "event", "T", "--body", "推了 b2f98ff", "--now", "待 review b2f98ff") == 0
    assert _now(board) == "待 review b2f98ff"
    assert "待 review b2f98ff" in context_loader.build_context(board, "T", lens_k=0)


def test_card_never_handed_off_hands_off_as_before(board, capsys):
    assert _handoff(board, "交接一次") == 0
    assert "✓ handoff T(handed_off)" in capsys.readouterr().out
    assert _now(board) == "交接一次"


def test_card_held_by_someone_else_keeps_the_old_refusal(board, capsys, monkeypatch):
    assert _handoff(board, "worker 交接") == 0
    with sqlite3.connect(board) as con:
        con.execute("UPDATE tasks SET owner='other' WHERE id='T'")
    assert _handoff(board, "worker 再交接") == 1
    err = capsys.readouterr().err
    assert "无未收尾的 session 履历" in err and "nawaban event" not in err

    monkeypatch.setenv("NAWABAN_OWNER", "stranger")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "stranger-session")
    assert _handoff(board, "陌生人交接") == 1
    err = capsys.readouterr().err
    assert "无未收尾的 session 履历" in err and "nawaban event" not in err
    assert _now(board) == "worker 交接"
