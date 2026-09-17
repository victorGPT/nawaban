"""Database and listener compatibility at the public configuration boundary."""

import os
from pathlib import Path
import subprocess
import sys
import types

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Match the existing tests: liveness packaging is outside these path checks.
sys.modules.setdefault("foreman_liveness", types.ModuleType("foreman_liveness"))
from nawaban import board_view, cli, db, guard  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch, tmp_path):
    for key in tuple(os.environ):
        if key.startswith(("NAWABAN_", "WORKOS_")):  # Legacy configuration isolation.
            monkeypatch.delenv(key)
    monkeypatch.chdir(tmp_path)


def test_new_database_environment_takes_priority_over_legacy(monkeypatch, tmp_path):
    legacy = tmp_path / "legacy.db"
    primary = tmp_path / "primary.db"
    monkeypatch.setenv("WORKOS_DB", str(legacy))  # Legacy fallback.
    assert db.resolve_db() == legacy
    monkeypatch.setenv("NAWABAN_DB", str(primary))
    assert db.resolve_db() == primary
    assert cli.main(["init"]) == 0
    assert primary.is_file()
    assert not legacy.exists()


def test_explicit_database_overrides_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("NAWABAN_DB", str(tmp_path / "environment.db"))
    explicit = tmp_path / "explicit.db"
    assert cli.main(["--db", str(explicit), "init"]) == 0
    assert explicit.is_file()
    assert not (tmp_path / "environment.db").exists()


def test_init_in_empty_directory_creates_new_default(tmp_path):
    assert cli.main(["init"]) == 0
    assert (tmp_path / ".nawaban/nawaban.db").is_file()


def test_init_reuses_legacy_board_without_creating_a_second_database(tmp_path):
    legacy = tmp_path / ".foreman/workos.db"  # Legacy path fallback.
    legacy.parent.mkdir()
    db.init_db(legacy)
    db.create_task(legacy, task_id="EXISTING", title="Existing task", context="Saved context")
    primary = tmp_path / ".nawaban/nawaban.db"
    primary.parent.mkdir()
    assert db.resolve_db() == legacy
    assert db.foreman_dir() == legacy.parent
    assert guard.db.board_db(tmp_path) == legacy
    assert cli.main(["init"]) == 0
    assert not primary.exists()
    assert db.resolve_db() == legacy
    assert guard.db.board_db(tmp_path) == legacy
    assert legacy.is_file()
    with db.connect(legacy) as con:
        assert con.execute("SELECT context FROM tasks WHERE id='EXISTING'").fetchone()[0] == "Saved context"


def test_existing_primary_board_keeps_priority(tmp_path):
    legacy = tmp_path / ".foreman/workos.db"
    primary = tmp_path / ".nawaban/nawaban.db"
    db.init_db(legacy)
    db.init_db(primary)
    assert cli.main(["init"]) == 0
    assert db.resolve_db() == primary


def test_init_upgrades_reused_legacy_schema_and_preserves_context(tmp_path):
    legacy = tmp_path / ".foreman/workos.db"
    db.init_db(legacy)
    db.create_task(legacy, task_id="LEGACY", title="Existing task", context="Saved context")
    with db.connect(legacy) as con:
        con.execute("ALTER TABLE tasks RENAME COLUMN context TO origin")
        con.execute("ALTER TABLE tasks DROP COLUMN project")
    assert cli.main(["init"]) == 0
    assert not (tmp_path / ".nawaban/nawaban.db").exists()
    detail = board_view.task_detail(legacy, "LEGACY")
    assert detail["context"] == "Saved context"
    with db.connect(legacy) as con:
        assert con.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 1
        columns = {row[1] for row in con.execute("PRAGMA table_info(tasks)")}
    assert "context" in columns and "project" in columns and "origin" not in columns


def test_linked_worktree_uses_main_board(tmp_path, monkeypatch):
    main = tmp_path / "main"
    main.mkdir()
    subprocess.run(["git", "init", "-q", str(main)], check=True)
    subprocess.run(["git", "-C", str(main), "-c", "user.name=Test", "-c",
                    "user.email=test@example.invalid", "commit", "-qm", "Initial", "--allow-empty"], check=True)
    linked = tmp_path / "linked"
    subprocess.run(["git", "-C", str(main), "worktree", "add", "-q", "-b", "linked", str(linked)], check=True)
    monkeypatch.chdir(linked)
    assert cli.main(["init"]) == 0
    primary = main / ".nawaban/nawaban.db"
    assert db.resolve_db() == primary
    assert not (linked / ".nawaban").exists()


@pytest.mark.parametrize("relative", [".nawaban/nawaban.db", ".foreman/workos.db"])
def test_main_checkout_write_gate_with_new_or_legacy_board(tmp_path, relative):
    # Both the primary and legacy fallback must retain the existing write boundary.
    (tmp_path / ".git").mkdir()
    db.init_db(tmp_path / relative)
    code, message = guard._judge_target(
        {"cwd": str(tmp_path), "tool_name": "Edit"}, "test", str(tmp_path / "source.py")
    )
    assert code == 2
    assert "worktree gate" in message


@pytest.mark.parametrize("use_new", [False, True])
def test_listener_environment_fallback_and_priority(monkeypatch, tmp_path, use_new):
    path = tmp_path / "board.db"
    db.init_db(path)
    monkeypatch.setenv("NAWABAN_DB", str(path))
    monkeypatch.setenv("WORKOS_BOARD_PORT", "18813")  # Legacy listener fallback.
    monkeypatch.setenv("WORKOS_BOARD_HOST", "127.0.0.2")
    if use_new:
        monkeypatch.setenv("NAWABAN_BOARD_PORT", "18814")
        monkeypatch.setenv("NAWABAN_BOARD_HOST", "127.0.0.1")
    calls = []
    monkeypatch.setattr(board_view, "serve", lambda *args, **kwargs: calls.append((args, kwargs)))
    assert board_view.main([]) == 0
    assert calls == [((path, 18814 if use_new else 18813),
                      {"host": "127.0.0.1" if use_new else "127.0.0.2"})]


def test_decision_channel_legacy_fallback_preserves_gate(monkeypatch, tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="CHECK-001", title="Check")
    args = dict(question="Proceed?", verdict="Yes", decided_by="user")
    with pytest.raises(db.NawabanError, match="拍板通道"):
        db.decide(path, "CHECK-001", **args)
    monkeypatch.setenv("WORKOS_DECISION_CHANNEL", "inbox")  # Legacy authorization channel.
    db.decide(path, "CHECK-001", **args)
    monkeypatch.setenv("NAWABAN_DECISION_CHANNEL", "invalid")
    with pytest.raises(db.NawabanError, match="拍板通道"):
        db.decide(path, "CHECK-001", **args)
