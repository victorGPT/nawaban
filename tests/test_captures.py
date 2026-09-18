"""Capture lifecycle, additive migration, CLI gates, and read-only projections."""
import json
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest

from nawaban import board_view, captures, cli, db


@pytest.fixture
def board(tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="FORMAL", title="Users can save ideas", project="demo")
    return path


def idea(board, **kwargs):
    return captures.add(board, content="An idea", project="demo", owner="human", **kwargs)


def snapshot(path):
    with sqlite3.connect(path) as con:
        return list(con.iterdump())


def test_additive_migration_preserves_existing_schema_and_data(board):
    with sqlite3.connect(board) as con:
        con.execute("DROP TABLE captures")
    before = snapshot(board)
    assert captures.read(board) == []
    assert board_view.task_detail(board, "FORMAL")["captures"] == []
    assert snapshot(board) == before
    assert db.migrate_db(board) == ["captures"]
    after = snapshot(board)
    assert all(line in after for line in before)
    assert db.migrate_db(board) == []
    assert snapshot(board) == after


def test_capture_never_enters_task_projections(board):
    projections = [board_view.board_data, board_view.modules_data, board_view.projects_data]
    before = [f(board) for f in projections]
    idea(board)
    assert [f(board) for f in projections] == before
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT count(*) FROM tasks").fetchone()[0] == 1


def test_retry_is_idempotent_even_after_resolution(board):
    key = str(uuid.uuid4())
    first = idea(board, capture_id=key)
    assert idea(board, capture_id=key) == first
    result = captures.resolve(board, key, owner="agent", task_id="FORMAL")
    assert idea(board, capture_id=key) == result
    with pytest.raises(db.NawabanError, match="其他内容"):
        captures.add(board, content="different", project="demo", owner="human", capture_id=key)
    assert len(captures.read(board, status="all")) == 1


def test_conversion_requires_existing_task_and_is_terminal(board):
    item = idea(board)
    with pytest.raises(db.NawabanError, match="正式建卡"):
        captures.resolve(board, item["id"], owner="agent", task_id="MISSING")
    assert captures.read(board)[0]["status"] == "pending"
    result = captures.resolve(board, item["id"], owner="agent", task_id="FORMAL")
    assert result["status"] == "converted"
    assert captures.read(board) == []
    assert board_view.task_detail(board, "FORMAL")["captures"] == [result]
    assert captures.resolve(board, item["id"], owner="other", task_id="FORMAL") == result
    with pytest.raises(db.NawabanError, match="已处理"):
        captures.resolve(board, item["id"], owner="agent", reason="Changed mind")


def test_discard_requires_reason_and_leaves_history(board):
    item = idea(board)
    with pytest.raises(db.NawabanError, match="原因"):
        captures.resolve(board, item["id"], owner="agent", reason=" ")
    result = captures.resolve(board, item["id"], owner="agent", reason="Already covered")
    assert result["reason"] == "Already covered" and result["resolved_by"] == "agent"
    assert captures.read(board) == []
    assert captures.read(board, status="discarded") == [result]
    assert captures.resolve(board, item["id"], owner="agent", reason="Already covered") == result
    with pytest.raises(db.NawabanError, match="已处理"):
        captures.resolve(board, item["id"], owner="agent", task_id="FORMAL")


def test_simultaneous_resolutions_have_one_winner(board):
    item = idea(board)
    def resolve(action):
        try:
            return captures.resolve(board, item["id"], owner="agent", **action)["status"]
        except db.NawabanError:
            return "rejected"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(resolve, [{"task_id": "FORMAL"}, {"reason": "Not needed"}]))
    assert results.count("rejected") == 1
    assert captures.read(board) == []


def test_simultaneous_save_retries_have_one_row(board):
    key = str(uuid.uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: idea(board, capture_id=key), range(2)))
    assert results[0] == results[1]
    assert len(captures.read(board)) == 1


@pytest.mark.parametrize("content", [None, [], True, "", " ", "x" * 4001])
def test_invalid_content_is_rejected_at_write_boundary(board, content):
    with pytest.raises(db.NawabanError):
        captures.add(board, content=content, project=None, owner="human")
    assert captures.read(board) == []


def test_project_filter_and_cli_lifecycle(board, capsys):
    def run(*args):
        assert cli.main(["--db", str(board), "capture", *args]) == 0
        return json.loads(capsys.readouterr().out)
    first = run("add", "--content", "Inbox idea", "--project", "demo")
    second = run("add", "--content", "Unassigned idea")
    assert run("list", "--project", "demo") == [first]
    assert run("list", "--unassigned") == [second]
    run("convert", first["id"], "--task", "FORMAL")
    assert run("list") == [second]
    assert run("list", "--task", "FORMAL")[0]["id"] == first["id"]
    run("discard", second["id"], "--reason", "No longer needed")
    assert run("list") == []
    # Capturing an idea does not provide a second way around formal creation gates.
    assert cli.main(["--db", str(board), "create", "BYPASS", "--title", "A visible result", "--context", "Not a bullet list"]) == 1


def test_capture_read_handles_reserved_uri_characters(tmp_path):
    path = tmp_path / "board?#%.db"
    db.init_db(path)
    item = idea(path)
    assert captures.read(path) == [item]


@pytest.mark.parametrize("material", [{"reason": "bad\x00reason"}, {"reason": "bad\ud800"},
                                    {"task_id": "bad\x00task"}, {"task_id": "bad\ud800"}])
def test_resolution_rejects_untransportable_material_without_changing_state(board, material):
    item = idea(board)
    with pytest.raises(db.NawabanError):
        captures.resolve(board, item["id"], owner="agent", **material)
    assert captures.read(board) == [item]
