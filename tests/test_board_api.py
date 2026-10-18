"""The board's read JSON API on a board built through the tracker CLI (spec NAWABAN-LEAN, seam 2)."""

import json
import sqlite3
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from nawaban import board_view, tracker


@pytest.fixture
def board(tmp_path, monkeypatch, capsys):
    path = tmp_path / "proj" / ".nawaban" / "board.db"

    def cli(*args, who="s-1"):
        monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", who)
        assert tracker.main(["--db", str(path), *args]) == 0, capsys.readouterr().err
        capsys.readouterr()

    cli("init")
    return path, cli


@pytest.fixture
def get(board):
    path, _ = board
    servers = []

    def get(url, db=path, method="GET"):
        if not servers:
            class Handler(board_view._Handler):
                db_path = db
            srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
            servers.append(srv)
        req = urllib.request.Request(f"http://127.0.0.1:{servers[0].server_address[1]}{url}",
                                     method=method, data=b"{}" if method != "GET" else None)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    yield get
    for srv in servers:
        srv.shutdown()
        srv.server_close()


def column(board_json, key):
    return {c["key"]: [t["id"] for t in c["tasks"]] for c in board_json["columns"]}[key]


def test_empty_board_has_no_projects_and_empty_columns(get):
    assert get("/api/projects") == (200, {"projects": []})
    code, data = get("/api/board")
    assert code == 200
    assert [(c["key"], c["tasks"]) for c in data["columns"]] == [
        ("open", []), ("in_progress", []), ("done", [])]


def test_projects_count_open_and_total_tasks(board, get):
    _, cli = board
    cli("create", "A", "--title", "a", "--body", "", "--project", "alpha")
    cli("create", "B", "--title", "b", "--body", "", "--project", "alpha")
    cli("create", "C", "--title", "c", "--body", "", "--project", "beta")
    cli("close", "B", "--done")
    assert get("/api/projects")[1] == {"projects": [
        {"name": "alpha", "open": 1, "total": 2}, {"name": "beta", "open": 1, "total": 1}]}


def test_board_columns_follow_derived_status(board, get):
    _, cli = board
    for t in ("OPEN", "HELD", "DONE", "GONE"):
        cli("create", t, "--title", t.lower(), "--body", "")
    cli("claim", "HELD")
    cli("close", "DONE", "--done")
    cli("close", "GONE", "--cancelled")
    data = get("/api/board")[1]
    assert column(data, "open") == ["OPEN"]
    assert column(data, "in_progress") == ["HELD"]
    assert column(data, "done") == ["DONE"]
    held = data["columns"][1]["tasks"][0]
    assert held["status"] == "in_progress" and held["session"] == "s-1"


def test_board_filters_by_project_and_unassigned(board, get):
    _, cli = board
    cli("create", "A", "--title", "a", "--body", "", "--project", "alpha")
    cli("create", "B", "--title", "b", "--body", "", "--project", "beta")
    assert column(get("/api/board?project=alpha")[1], "open") == ["A"]
    assert column(get("/api/board?unassigned=1")[1], "open") == []


def test_board_rejects_a_malformed_date_range(get):
    assert get("/api/board?since=yesterday")[0] == 400


def test_task_shows_body_status_and_project(board, get):
    _, cli = board
    cli("create", "T", "--title", "能看到任务", "--body", "## Acceptance criteria\n- 可以",
        "--project", "alpha")
    code, d = get("/api/task?id=T")
    assert code == 200
    assert (d["id"], d["title"], d["status"], d["project"], d["session"]) == (
        "T", "能看到任务", "open", "alpha", None)
    assert d["body"] == "## Acceptance criteria\n- 可以"
    assert d["latest_note"] is None and d["decisions"] == [] and d["links"] == []
    assert d["created_at"] > 0


def test_task_shows_latest_note_decisions_and_links(board, get):
    _, cli = board
    cli("create", "T", "--title", "t", "--body", "")
    cli("event", "T", "--kind", "note", "--body", "第一步")
    cli("event", "T", "--kind", "decision", "--body", "用 A · 否:B", "--by", "user")
    cli("event", "T", "--kind", "link", "--body", "pr: https://example.test/pull/1")
    cli("event", "T", "--kind", "note", "--body", "第二步")
    d = get("/api/task?id=T")[1]
    assert d["latest_note"]["body"] == "第二步"
    assert [(e["body"], e["author"]) for e in d["decisions"]] == [("用 A · 否:B", "user")]
    assert [e["body"] for e in d["links"]] == ["pr: https://example.test/pull/1"]
    assert [e["kind"] for e in d["events"]] == ["note", "link", "decision", "note"]


def test_task_status_follows_claim_and_close(board, get):
    _, cli = board
    cli("create", "T", "--title", "t", "--body", "")
    cli("claim", "T")
    d = get("/api/task?id=T")[1]
    assert (d["status"], d["session"]) == ("in_progress", "s-1")
    cli("close", "T", "--done")
    d = get("/api/task?id=T")[1]
    assert (d["status"], d["session"]) == ("done", None)
    assert [e["kind"] for e in d["events"]] == ["status", "status"]


def test_task_shows_parent_children_blockers_and_dependents(board, get):
    _, cli = board
    cli("create", "SPEC", "--title", "spec", "--body", "")
    cli("create", "S-1", "--title", "one", "--body", "", "--parent", "SPEC")
    cli("create", "S-2", "--title", "two", "--body", "", "--parent", "SPEC", "--blocked-by", "S-1")
    cli("claim", "S-1")
    two = get("/api/task?id=S-2")[1]
    assert two["parent"] == {"id": "SPEC", "title": "spec", "status": "open"}
    assert two["blocked_by"] == [{"id": "S-1", "title": "one", "status": "in_progress"}]
    one = get("/api/task?id=S-1")[1]
    assert one["dependents"] == [{"id": "S-2", "title": "two", "status": "open"}]
    spec = get("/api/task?id=SPEC")[1]
    assert spec["parent"] is None
    assert [c["id"] for c in spec["children"]] == ["S-1", "S-2"]


def test_unknown_task_is_404(get):
    code, data = get("/api/task?id=NOPE")
    assert code == 404 and "NOPE" in data["error"]


def test_old_schema_board_is_refused(get, tmp_path):
    old = tmp_path / "old.db"
    sqlite3.connect(old).execute("CREATE TABLE tasks (id TEXT)").connection.close()
    code, data = get("/api/board", db=old)
    assert code == 503 and "不是新版看板" in data["error"]


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
@pytest.mark.parametrize("url", ["/api/task?id=T", "/api/board", "/api/answer", "/"])
def test_write_requests_are_rejected(board, get, method, url):
    path, cli = board
    cli("create", "T", "--title", "t", "--body", "")
    before = path.read_bytes()
    code, data = get(url, method=method)
    assert code == 405 and "只读" in data["error"]
    assert path.read_bytes() == before
