"""The session banner keeps the derived owner even when the session registry cannot be written."""

import importlib.util
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.modules.setdefault("foreman_liveness", types.ModuleType("foreman_liveness"))
_spec = importlib.util.spec_from_file_location("session_start", ROOT / "hooks" / "foreman_session_start.py")
session_start = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(session_start)


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
