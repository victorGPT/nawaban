"""Legacy cards remain discoverable and can receive an audited project."""
import http.client
import json
import os
import sqlite3
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer

import pytest

from nawaban import board_view as bv, db, inbox


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
    assert tid in {t["id"] for c in bv.board_data(board, project="demo")["columns"] for t in c["tasks"]}
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


def test_unassigned_projects_include_null_and_empty_without_named_cards(board):
    assert {t["id"] for c in bv.board_data(board, project="")["columns"] for t in c["tasks"]} == {"NULL", "EMPTY"}
    assert {t["i"] for t in bv.modules_data(board, project="")["tasks"]} == {"NULL", "EMPTY"}
    data = bv.project_inbox(board, inbox.read(board), "")
    assert {tid for g in data["groups"] for a in g["items"] for tid in a["task_ids"]} == {"NULL", "EMPTY"}
    assert data["total"] == 2
    assert bv.projects_data(board)["projects"] == [
        {"name": "demo", "open": 1, "total": 1}, {"name": None, "open": 2, "total": 2}]


def test_unassigned_http_filter_and_legacy_all_projects_url(board, monkeypatch):
    class Handler(bv._Handler):
        db_path = board
    monkeypatch.setattr(bv, "_liveness_index", lambda: (None, True))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        for endpoint, ids in [
            ("board", lambda d: {t["id"] for c in d["columns"] for t in c["tasks"]}),
            ("modules", lambda d: {t["i"] for t in d["tasks"]}),
            ("inbox", lambda d: {tid for g in d["groups"] for a in g["items"] for tid in a["task_ids"]}),
        ]:
            for query, expected in [("unassigned=1", {"NULL", "EMPTY"}), ("project=", {"NULL", "EMPTY", "NAMED"}), ("project=demo", {"NAMED"})]:
                conn = http.client.HTTPConnection(*server.server_address, timeout=3)
                conn.request("GET", f"/api/{endpoint}?{query}")
                response = conn.getresponse()
                assert response.status == 200
                assert ids(json.loads(response.read())) == expected
                conn.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
