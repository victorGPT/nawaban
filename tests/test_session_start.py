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
sys.modules.setdefault("foreman_liveness", types.ModuleType("foreman_liveness"))
_spec = importlib.util.spec_from_file_location("session_start", ROOT / "hooks" / "foreman_session_start.py")
session_start = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(session_start)


@pytest.fixture(autouse=True)
def isolated_legacy_registry(monkeypatch, tmp_path):
    monkeypatch.setattr(session_start, "_LEGACY_REGISTRY", tmp_path / "legacy-registry.json", raising=False)


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
    assert result["no-tmux:12345678"]["session"] == "12345678-new"
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
    for k in ("FOREMAN_OWNER", "TMUX_PANE"):
        monkeypatch.delenv(k, raising=False)


def test_owner_falls_back_to_session_prefix(monkeypatch, tmp_path):
    _no_identity(monkeypatch)
    monkeypatch.setattr(session_start, "_REGISTRY", tmp_path / "state" / "registry.json")
    assert session_start._register_session("12345678-abcd", str(tmp_path)) == ("ac:12345678", "12345678-abcd")


def test_unwritable_registry_keeps_the_owner(monkeypatch, tmp_path):
    _no_identity(monkeypatch)
    blocker = tmp_path / "file"
    blocker.write_text("x")
    monkeypatch.setattr(session_start, "_REGISTRY", blocker / "registry.json")  # parent is a file
    assert session_start._register_session("12345678-abcd", str(tmp_path)) == ("ac:12345678", "12345678-abcd")


def _prepare_main(monkeypatch, tmp_path, cwd):
    for key in ("NAWABAN_DB", "WORKOS_DB", "NAWABAN_CONTEXT_BANNER", "WORKOS_CONTEXT_BANNER"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(sys, "argv", ["foreman_session_start.py"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"cwd": str(cwd), "session_id": "test-sid"})))
    monkeypatch.setattr(session_start, "_register_session", lambda *args: ("ac:test", "test-sid"))
    monkeypatch.setattr(session_start, "_reclaim_stale_owners", lambda *args: None)
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


@pytest.mark.parametrize("variable", ["NAWABAN_DB", "WORKOS_DB"])
def test_explicit_database_overrides_local_board(monkeypatch, tmp_path, capsys, variable):
    repo = tmp_path / "repo"
    local = repo / ".foreman/workos.db"
    selected = tmp_path / "other/selected.db"
    for path, task_id in ((local, "T-LOCAL"), (selected, "T-SELECTED")):
        db.init_db(path)
        db.create_task(path, task_id=task_id, title="Selected task")
        db.claim_task(path, task_id, owner="ac:test", session_id="test-sid")
    _prepare_main(monkeypatch, tmp_path, repo)
    monkeypatch.setenv(variable, str(selected))
    assert session_start.main() == 0
    output = capsys.readouterr().out
    assert "T-SELECTED" in output
    assert "T-LOCAL" not in output


@pytest.mark.parametrize("primary,legacy,expected", [
    ("new", "old", "new"), (None, "old", "old"), (None, None, ".local/state/nawaban"),
])
def test_state_directory_priority(monkeypatch, tmp_path, primary, legacy, expected):
    monkeypatch.setenv("HOME", str(tmp_path))
    for key, value in (("NAWABAN_STATE_DIR", primary), ("WORKOS_STATE_DIR", legacy)):
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, str(tmp_path / value))
    spec = importlib.util.spec_from_file_location("state_dir_hook", ROOT / "hooks/foreman_session_start.py")
    hook = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hook)
    assert hook._STATE == tmp_path / expected
    assert hook._REGISTRY == tmp_path / expected / "session-registry.json"
