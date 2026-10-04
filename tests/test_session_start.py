"""The session banner keeps the derived owner even when the session registry cannot be written."""

import importlib.util
import io
import json
from datetime import datetime

import pytest

from nawaban import db
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("session_start", ROOT / "hooks" / "foreman_session_start.py")
session_start = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(session_start)


@pytest.fixture(autouse=True)
def isolated_legacy_registry(monkeypatch, tmp_path):
    monkeypatch.setattr(session_start, "_LEGACY_REGISTRY", tmp_path / "legacy-registry.json", raising=False)
    monkeypatch.setattr(session_start, "_LEGACY_STATE", tmp_path / "legacy-state", raising=False)


def test_list_reads_legacy_registry_without_moving_it(monkeypatch, tmp_path, capsys):
    current = tmp_path / "new/registry.json"
    old = session_start._LEGACY_REGISTRY
    saved = {"old-pane": {"session": "old-session", "cwd": "/example/project", "ts": "2026-01-01"}}
    old.write_text(json.dumps(saved))
    monkeypatch.setattr(session_start, "_REGISTRY", current)
    assert session_start._print_registry() == 0
    assert "old-session" in capsys.readouterr().out
    assert not current.exists()
    assert json.loads(old.read_text()) == saved


def test_register_preserves_old_sessions_in_new_location(monkeypatch, tmp_path):
    _no_identity(monkeypatch)
    current = tmp_path / "new/registry.json"
    old = session_start._LEGACY_REGISTRY
    saved = {"old-pane": {"session": "old-session", "ts": "2026-01-01"}}
    old.write_text(json.dumps(saved))
    monkeypatch.setattr(session_start, "_REGISTRY", current)
    session_start._register_session("12345678-new", str(tmp_path))
    result = json.loads(current.read_text())
    assert result["old-pane"] == saved["old-pane"]
    assert result["no-tmux:12345678-new"]["session"] == "12345678-new"
    assert json.loads(old.read_text()) == saved


def test_new_registry_takes_priority(monkeypatch, tmp_path, capsys):
    current = tmp_path / "registry.json"
    current.write_text(json.dumps({"new": {"session": "new-session", "ts": "2026-01-02"}}))
    session_start._LEGACY_REGISTRY.write_text(json.dumps({"old": {"session": "old-session"}}))
    monkeypatch.setattr(session_start, "_REGISTRY", current)
    session_start._print_registry()
    output = capsys.readouterr().out
    assert "new-session" in output and "old-session" not in output


def _no_identity(monkeypatch):
    for k in ("NAWABAN_OWNER", "TMUX_PANE"):
        monkeypatch.delenv(k, raising=False)


def test_owner_falls_back_to_session_prefix(monkeypatch, tmp_path):
    _no_identity(monkeypatch)
    monkeypatch.setattr(session_start, "_REGISTRY", tmp_path / "state" / "registry.json")
    assert session_start._register_session("12345678-abcd", str(tmp_path)) == ("ac:12345678-abcd", "12345678-abcd")


def test_unwritable_registry_keeps_the_owner(monkeypatch, tmp_path):
    _no_identity(monkeypatch)
    blocker = tmp_path / "file"
    blocker.write_text("x")
    monkeypatch.setattr(session_start, "_REGISTRY", blocker / "registry.json")  # parent is a file
    assert session_start._register_session("12345678-abcd", str(tmp_path)) == ("ac:12345678-abcd", "12345678-abcd")


def _prepare_main(monkeypatch, tmp_path, cwd):
    for key in ("NAWABAN_DB", "NAWABAN_CONTEXT_BANNER"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(sys, "argv", ["foreman_session_start.py"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"cwd": str(cwd), "session_id": "test-sid"})))
    monkeypatch.setattr(session_start, "_register_session", lambda *args: ("ac:test", "test-sid"))
    monkeypatch.setattr(session_start, "_reclaim_stale_owners", lambda *args: None)
    monkeypatch.setattr(session_start, "_main_ci", lambda cwd: None)
    state = tmp_path / "state"
    state.mkdir()
    (state / "foreman-stale.last").write_text(datetime.now().strftime("%Y-%m-%d"))
    monkeypatch.setattr(session_start, "_STATE", state)


def test_legacy_markdown_board_without_database_still_renders(monkeypatch, tmp_path, capsys):
    pytest.importorskip("yaml", reason="Legacy Markdown parsing optionally uses PyYAML")
    repo = tmp_path / "repo"
    active = repo / ".foreman/tasks/demo/active"
    active.mkdir(parents=True)
    (active / "T-OLD.md").write_text(
        '---\ntask_id: T-OLD\nstatus: in_progress\nowner: "ac:test"\n'
        'touches:\n  - src/legacy.py\n---\n# Legacy task\n')
    _prepare_main(monkeypatch, tmp_path, repo)
    assert session_start.main() == 0
    assert "T-OLD · touches: src/legacy.py" in capsys.readouterr().out
    assert not (repo / ".nawaban").exists()


def test_explicit_database_overrides_local_board(monkeypatch, tmp_path, capsys):
    repo = tmp_path / "repo"
    local = repo / ".foreman/workos.db"
    selected = tmp_path / "other/selected.db"
    for path, task_id in ((local, "T-LOCAL"), (selected, "T-SELECTED")):
        db.init_db(path)
        db.create_task(path, task_id=task_id, title="Selected task")
        db.claim_task(path, task_id, owner="ac:test", session_id="test-sid")
    _prepare_main(monkeypatch, tmp_path, repo)
    monkeypatch.setenv("NAWABAN_DB", str(selected))
    assert session_start.main() == 0
    output = capsys.readouterr().out
    assert "T-SELECTED" in output
    assert "T-LOCAL" not in output


@pytest.mark.parametrize("configured,expected", [
    ("new", "new"), (None, ".local/state/nawaban"),
])
def test_state_directory(monkeypatch, tmp_path, configured, expected):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("WORKOS_STATE_DIR", str(tmp_path / "retired"))
    if configured is None:
        monkeypatch.delenv("NAWABAN_STATE_DIR", raising=False)
    else:
        monkeypatch.setenv("NAWABAN_STATE_DIR", str(tmp_path / configured))
    spec = importlib.util.spec_from_file_location("state_dir_hook", ROOT / "hooks/foreman_session_start.py")
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    assert hook._STATE == tmp_path / expected
    assert hook._REGISTRY == tmp_path / expected / "session-registry.json"


@pytest.mark.parametrize("new_report,new_marker,old_marker,spawn", [
    (None, None, "today", False),
    (None, None, "yesterday", True),
    ("Current stale report", "yesterday", "today", True),
    ("Current stale report", "today", "yesterday", False),
])
def test_stale_state_reads_legacy_fallback_but_writes_current(
    monkeypatch, tmp_path, capsys, new_report, new_marker, old_marker, spawn,
):
    repo = tmp_path / "repo"
    board = repo / ".foreman/workos.db"
    db.init_db(board)
    db.create_task(board, task_id="DEMO-STALE-001", title="Active fixture")
    db.claim_task(board, "DEMO-STALE-001", owner="ac:test", session_id="test-sid")
    _prepare_main(monkeypatch, tmp_path, repo)
    monkeypatch.setattr(session_start, "_warn_dirty_main_tree", lambda *args: None)
    monkeypatch.setattr(session_start, "_inbox_banner", lambda *args: False)
    calls = []
    monkeypatch.setattr(session_start, "subprocess", types.SimpleNamespace(
        Popen=lambda *args, **kwargs: calls.append(args),
    ))
    current, legacy = session_start._STATE, session_start._LEGACY_STATE
    legacy.mkdir()
    today = datetime.now().strftime("%Y-%m-%d")
    dates = {"today": today, "yesterday": "2000-01-01"}
    (legacy / "foreman-stale.txt").write_text("Legacy stale report\nDetails")
    (legacy / "foreman-stale.last").write_text(dates[old_marker])
    if new_report is not None:
        (current / "foreman-stale.txt").write_text(new_report)
    marker = current / "foreman-stale.last"
    if new_marker is None:
        marker.unlink()
    else:
        marker.write_text(dates[new_marker])

    assert session_start.main() == 0
    output = capsys.readouterr().out
    assert (new_report or "Legacy stale report") in output
    if new_report:
        assert "Legacy stale report" not in output
    assert len(calls) == int(spawn)
    assert (legacy / "foreman-stale.txt").read_text() == "Legacy stale report\nDetails"
    assert (legacy / "foreman-stale.last").read_text() == dates[old_marker]
    if spawn:
        assert marker.read_text() == today
        command = calls[0][0][2]
        assert str(current / "foreman-stale.txt") in command
        assert str(legacy) not in command
    elif new_marker is None:
        assert not marker.exists()


def test_main_ci_banner_reports_red_and_errors_and_throttles_refresh(monkeypatch, tmp_path, capsys):
    repo = tmp_path / "app"
    db.init_db(repo / ".nawaban/nawaban.db")
    monkeypatch.setattr(session_start, "_STATE", tmp_path / "state")
    spawned, real = [], session_start.subprocess.Popen
    monkeypatch.setattr(session_start.subprocess, "Popen", lambda args, **kw: spawned.append(args)
                        if "nawaban.main_ci" in args else real(args, **kw))
    session_start._main_ci(repo)
    assert capsys.readouterr().out == "" and "--state-dir" in spawned[0]

    target = session_start.main_ci.state_file(tmp_path / "state", "app")
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"checked_at": int(datetime.now().timestamp()), "error": "gh: no access",
                                  "red": [{"workflow": "test", "url": "https://ci/1", "since": 0}]}))
    session_start._main_ci(repo)
    out = capsys.readouterr().out
    assert "main CI 红:test https://ci/1" in out and "停线闸不生效:gh: no access" in out
    assert len(spawned) == 1  # a check from the last 10 minutes is reused
