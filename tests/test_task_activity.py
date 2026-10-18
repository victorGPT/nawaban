"""Reclamation reads task event activity without changing persistence."""
import sqlite3
from unittest.mock import Mock

import pytest

from nawaban import db, reclaim_stale


@pytest.fixture
def remodulated_tasks(tmp_path, monkeypatch):
    path = tmp_path / "activity.db"
    db.init_db(path)
    monkeypatch.setattr(db, "_now", lambda: 100)
    for tid in ("EVENTS", "STARTED", "CREATED"):
        db.create_task(path, task_id=tid, title="Example task", epic="WORKOS")
    with sqlite3.connect(path) as con:
        con.execute("UPDATE tasks SET status='in_progress', owner='fixture:' || id")
        con.execute("UPDATE tasks SET started_at=200 WHERE id IN ('EVENTS','STARTED')")
    monkeypatch.setattr(db, "_now", lambda: 300)
    db.add_event(path, "EVENTS", kind="note", body="Work advanced", author="fixture")
    monkeypatch.setattr(db, "_now", lambda: 400)
    db.remodule(path, ["EVENTS", "STARTED", "CREATED"], epic="看板界面",
                reason="统一中文短名", author="fixture")
    return path


def _activity(path, monkeypatch):
    judge = Mock(wraps=reclaim_stale._judge)
    monkeypatch.setattr(reclaim_stale, "_judge", judge)
    monkeypatch.setattr(reclaim_stale, "_transcript_mtimes", lambda: {})
    monkeypatch.setattr(reclaim_stale, "_herdr_owners", lambda: set())
    reclaim_stale.sweep(path)
    return {call.args[0].removeprefix("fixture:"): call.args[1]
            for call in judge.call_args_list}


def test_remodule_does_not_reset_activity(remodulated_tasks, monkeypatch):
    path = remodulated_tasks
    with sqlite3.connect(path) as con:
        events = con.execute("SELECT * FROM task_events ORDER BY id").fetchall()
        schema = con.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall()
    activity = _activity(path, monkeypatch)
    assert activity["EVENTS"] == 300
    # Reclamation retains its existing no-event behavior, without a fallback.
    assert activity["STARTED"] is None
    assert activity["CREATED"] is None
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT * FROM task_events ORDER BY id").fetchall() == events
        assert con.execute("SELECT sql FROM sqlite_master ORDER BY name").fetchall() == schema


@pytest.mark.parametrize("kind,body", [
    ("note", "模块 implementation advanced"),
    ("note", "Progress: 模块 WORKOS → 看板界面"),
    ("coord", "模块 WORKOS → 看板界面 · Work advanced"),
])
def test_other_events_still_count(remodulated_tasks, monkeypatch, kind, body):
    monkeypatch.setattr(db, "_now", lambda: 500)
    db.add_event(remodulated_tasks, "EVENTS", kind=kind, body=body, author="fixture")
    assert _activity(remodulated_tasks, monkeypatch)["EVENTS"] == 500


def test_remodule_does_not_delay_reclamation(remodulated_tasks, monkeypatch):
    monkeypatch.setattr(reclaim_stale, "_transcript_mtimes", lambda: {})
    monkeypatch.setattr(reclaim_stale, "_herdr_owners", lambda: set())
    # T1 is stale while T2 would still be recent under the existing threshold.
    monkeypatch.setattr(reclaim_stale.time, "time",
                        lambda: 350 + reclaim_stale.FOREIGN_STALE_H * 3600)
    assert {r[0] for r in reclaim_stale.sweep(remodulated_tasks)} == {
        "EVENTS", "STARTED", "CREATED"}
