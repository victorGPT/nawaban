"""Card views agree on task event activity without changing persistence."""
import sqlite3

from nawaban import board_view as bv, db


def test_board_and_modules_share_latest_event_activity_and_no_event_fallback(tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    for tid in ("EVENTS", "STARTED", "CREATED"):
        db.create_task(path, task_id=tid, title="Example task", project="example")
    with sqlite3.connect(path) as con:
        con.execute("DELETE FROM task_events")
        con.execute("UPDATE tasks SET created_at=100, started_at=NULL")
        con.execute("UPDATE tasks SET started_at=200 WHERE id IN ('EVENTS','STARTED')")
        for timestamp in (400, 300):
            con.execute("INSERT INTO task_events(task_id,kind,body,author,created_at) VALUES ('EVENTS','note','Update','fixture',?)",
                        (timestamp,))
        schema = con.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall()
    expected = {"EVENTS": 400, "STARTED": 200, "CREATED": 100}
    assert {t["id"]: t["active_at"] for c in bv.board_data(path, project="example")["columns"]
            for t in c["tasks"]} == expected
    assert {t["i"]: t["active_at"] for t in bv.modules_data(path, project="example")["tasks"]} == expected
    assert bv.modules_data(path, project="other")["tasks"] == []
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall() == schema
