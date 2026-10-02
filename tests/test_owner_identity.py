"""Session collisions and legacy ownership use only temporary state."""

import io
import json
import os
import sqlite3
import subprocess
import sys
import time
from uuid import UUID

import pytest

from hooks import foreman_session_start as session_start
from nawaban import board_view, claim_check, cli, db, foreman_liveness, guard, reclaim_stale, stale_recon

SID_A = "01a0b483-321f-7000-8000-000000000001"
SID_B = "01a0b483-4dab-7000-8000-000000000002"
OWNER_A, OWNER_B = f"ac:{SID_A}", f"ac:{SID_B}"
LEGACY = "ac:01a0b483"


@pytest.fixture
def identities(monkeypatch, tmp_path):
    for name in ("NAWABAN_OWNER", "CLAUDE_CODE_SESSION_ID", "TMUX", "TMUX_PANE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(session_start, "_REGISTRY", tmp_path / "registry.json")
    monkeypatch.setattr(session_start, "_LEGACY_REGISTRY", tmp_path / "absent.json")
    assert str(UUID(SID_A)) == SID_A and str(UUID(SID_B)) == SID_B


def test_colliding_sessions_get_distinct_board_owners(identities, monkeypatch, tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    owners = []
    for tid, sid in (("A", SID_A), ("B", SID_B)):
        monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", sid)
        owner, session = cli._identity(need_session=True)
        owners.append(owner)
        db.create_task(path, task_id=tid, title=tid, touches=["shared.py"])
        assert db.claim_task(path, tid, owner=owner, session_id=session)
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT count(DISTINCT owner) FROM tasks").fetchone()[0] == 2
    assert owners == [OWNER_A, OWNER_B]


def test_banner_guard_cli_and_registry_agree(identities, monkeypatch, tmp_path):
    for sid, expected in ((SID_A, OWNER_A), (SID_B, OWNER_B)):
        monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", sid)
        assert cli._identity(need_session=True) == (expected, sid)
        assert guard.resolve_owner(sid) == expected
        assert session_start._register_session(sid, str(tmp_path)) == (expected, sid)
    saved = json.loads(session_start._REGISTRY.read_text())
    assert {row["session"] for row in saved.values()} == {SID_A, SID_B}


def test_explicit_legacy_owner_still_wins(identities, monkeypatch, tmp_path):
    monkeypatch.setenv("NAWABAN_OWNER", LEGACY)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SID_A)
    assert cli._identity(need_session=True) == (LEGACY, SID_A)
    assert guard.resolve_owner(SID_B) == LEGACY
    assert session_start._register_session(SID_A, str(tmp_path)) == (LEGACY, SID_A)


def _cards(tmp_path, owners):
    path = tmp_path / "board.db"
    db.init_db(path)
    for tid, owner, sid in owners:
        db.create_task(path, task_id=tid, title=tid, touches=["shared.py"])
        assert db.claim_task(path, tid, owner=owner, session_id=sid)
    return path


def test_claim_check_does_not_hide_colliding_window(identities, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SID_A)
    owner_a, _ = cli._identity(need_session=True)
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SID_B)
    owner_b, _ = cli._identity(need_session=True)
    path = _cards(tmp_path, [("A", owner_a, SID_A), ("B", owner_b, SID_B)])
    monkeypatch.setattr(claim_check, "owner_liveness", lambda: None)
    claim_check.report_conflicts(path, ["shared.py"], owner=owner_a, repo=tmp_path)
    output = capsys.readouterr().out
    assert "B(touches:" in output
    assert "A(touches:" not in output


def _transcripts(tmp_path, monkeypatch, provider):
    now = time.time()
    claude = tmp_path / ".claude/projects"
    monkeypatch.setattr(board_view, "TRANSCRIPTS", claude)
    for sid, age in ((SID_A, 0), (SID_B, 100 * 3600)):
        if provider == "claude":
            path = claude / "project" / f"{sid}.jsonl"
        else:
            path = tmp_path / ".codex/sessions/2026/09/21" / f"rollout-2026-09-21T00-00-00-{sid}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}\n")
        os.utime(path, (now - age, now - age))
    return now


@pytest.mark.parametrize("provider", ["claude", "codex"])
def test_transcript_reclaim_is_exact_and_keeps_legacy(identities, monkeypatch, tmp_path, provider):
    _transcripts(tmp_path, monkeypatch, provider)
    monkeypatch.setattr(reclaim_stale, "_herdr_owners", lambda: set())
    path = _cards(tmp_path, [("A", OWNER_A, SID_A), ("B", OWNER_B, SID_B),
                             ("OLD", LEGACY, SID_A)])
    assert [row[0] for row in reclaim_stale.sweep(path, apply=True)] == ["B"]
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT id, status, owner FROM tasks ORDER BY id").fetchall() == [
            ("A", "claimed", OWNER_A), ("B", "open", None), ("OLD", "claimed", LEGACY)]


@pytest.mark.parametrize("provider", ["claude", "codex"])
def test_board_liveness_separates_collision_and_keeps_legacy(identities, monkeypatch, tmp_path, provider):
    _transcripts(tmp_path, monkeypatch, provider)
    index, complete = board_view._transcript_index()
    assert complete
    assert board_view._live_of(OWNER_A, index)["tier"] == "working"
    assert board_view._live_of(OWNER_B, index)["tier"] == "cold"
    assert board_view._live_of(LEGACY, index)["tier"] == "working"


def test_herdr_only_protects_exact_new_owner_and_legacy(identities, monkeypatch, tmp_path):
    payload = json.dumps({"result": {"agents": [{"agent": "codex", "name": "A",
        "agent_session": {"kind": "id", "value": SID_A}}]}})
    monkeypatch.setattr(reclaim_stale.subprocess, "run", lambda *a, **kw:
                        subprocess.CompletedProcess([], 0, payload, ""))
    monkeypatch.setattr(foreman_liveness, "_run_herdr", lambda: payload)
    table = foreman_liveness.owner_liveness()
    assert OWNER_A in table and LEGACY in table and OWNER_B not in table
    monkeypatch.setattr(reclaim_stale, "_transcript_mtimes", lambda: {})
    path = _cards(tmp_path, [("A", OWNER_A, SID_A), ("B", OWNER_B, SID_B),
                             ("OLD", LEGACY, SID_A)])
    assert [row[0] for row in reclaim_stale.sweep(path, apply=True)] == ["B"]


def test_legacy_card_can_start_and_release_without_changing_owner(identities, tmp_path):
    path = _cards(tmp_path, [("OLD", LEGACY, SID_A)])
    with pytest.raises(db.NawabanError):
        db.start_task(path, "OLD", owner=OWNER_B, session_id=SID_B)
    with pytest.raises(db.NawabanError):
        db.handoff(path, "OLD", owner=OWNER_B, session_id=SID_B, outcome="handed_off",
                   summary="Wrong session", now="Must not release", release=True)
    db.start_task(path, "OLD", owner=OWNER_A, session_id=SID_A)
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT owner FROM tasks").fetchone()[0] == LEGACY
    db.handoff(path, "OLD", owner=OWNER_A, session_id=SID_A, outcome="handed_off",
               summary="Released", now="Ready for another session", release=True)
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT status, owner FROM tasks").fetchone() == ("open", None)


def test_claim_check_recognizes_only_own_legacy_card(identities, monkeypatch, tmp_path, capsys):
    path = _cards(tmp_path, [("MINE", LEGACY, SID_A), ("OTHER", LEGACY, SID_B)])
    monkeypatch.setattr(claim_check, "owner_liveness", lambda: None)
    claim_check.report_conflicts(path, ["shared.py"], owner=OWNER_A, repo=tmp_path)
    output = capsys.readouterr().out
    assert "OTHER(touches:" in output
    assert "MINE(touches:" not in output


def test_banner_recognizes_only_own_legacy_card(identities, monkeypatch, tmp_path, capsys):
    from datetime import datetime

    path = _cards(tmp_path, [("MINE", LEGACY, SID_A), ("OTHER", LEGACY, SID_B)])
    monkeypatch.setenv("NAWABAN_DB", str(path))
    monkeypatch.setenv("NAWABAN_CONTEXT_BANNER", "0")
    monkeypatch.setattr(sys, "argv", ["foreman_session_start.py"])
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({
        "session_id": SID_A, "cwd": str(tmp_path)})))
    monkeypatch.setattr(session_start, "_STATE", tmp_path)
    (tmp_path / "foreman-stale.last").write_text(datetime.now().strftime("%Y-%m-%d"))
    monkeypatch.setattr(session_start, "_inbox_banner", lambda *a: True)
    monkeypatch.setattr(session_start, "_warn_dirty_main_tree", lambda *a: None)
    monkeypatch.setattr(session_start, "_reclaim_stale_owners", lambda *a: None)
    assert session_start.main() == 0
    output = capsys.readouterr().out
    assert "MINE · touches:" in output
    assert "OTHER · touches:" not in output


@pytest.mark.parametrize("explicit", [None, LEGACY])
def test_stale_recon_uses_same_author(identities, monkeypatch, tmp_path, explicit):
    path = _cards(tmp_path, [("A", OWNER_A, SID_A)])
    monkeypatch.setenv("NAWABAN_DB", str(path))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", SID_A)
    if explicit:
        monkeypatch.setenv("NAWABAN_OWNER", explicit)
    monkeypatch.setattr(sys, "argv", ["stale_recon.py", "--repo", str(tmp_path)])
    monkeypatch.setattr(stale_recon, "fetch_merged", lambda repo: {})
    calls = []
    monkeypatch.setattr(stale_recon, "reconcile", lambda *a, **kw: calls.append(kw))
    monkeypatch.setattr(stale_recon, "print_report", lambda *a: None)
    assert stale_recon.main() == 0
    assert calls == [{"author": explicit or OWNER_A, "session_id": SID_A, "dry_run": True}]


@pytest.mark.parametrize("explicit", [None, LEGACY])
def test_legacy_session_guard_allows_its_worktree(identities, monkeypatch, tmp_path, explicit):
    main, worktree = tmp_path / "main", tmp_path / "worktree"
    (main / ".git/worktrees/worker").mkdir(parents=True)
    worktree.mkdir()
    (worktree / ".git").write_text(f"gitdir: {main}/.git/worktrees/worker\n")
    path = main / ".nawaban/nawaban.db"
    db.init_db(path)
    db.create_task(path, task_id="OLD", title="Legacy card", touches=["shared.py"])
    db.claim_task(path, "OLD", owner=LEGACY, session_id=SID_A)
    if explicit:
        monkeypatch.setenv("NAWABAN_OWNER", explicit)
    assert guard.judge({"session_id": SID_A, "cwd": str(worktree), "tool_name": "Edit",
                        "tool_input": {"file_path": str(worktree / "shared.py")}}) == (0, "")


def test_ended_legacy_session_does_not_grant_start(identities, tmp_path):
    path = _cards(tmp_path, [("OLD", LEGACY, SID_A)])
    db.handoff(path, "OLD", owner=LEGACY, session_id=SID_A, outcome="handed_off",
               summary="Session closed", now="Waiting for a new claim")
    with pytest.raises(db.NawabanError):
        db.start_task(path, "OLD", owner=OWNER_A, session_id=SID_A)


def test_liveness_script_imports_shared_identity_without_pythonpath():
    code = f"import runpy; runpy.run_path({foreman_liveness.__file__!r}, run_name='probe')"
    result = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
