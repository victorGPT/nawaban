"""The CLI entry points and where they find the board."""

import os
from pathlib import Path
import re
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nawaban import board_view, cli  # noqa: E402

VERBS = {"init", "create", "block", "claim", "close", "event", "show", "list", "backup", "migrate"}


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch, tmp_path):
    for key in tuple(os.environ):
        if key.startswith("NAWABAN_"):
            monkeypatch.delenv(key)
    monkeypatch.chdir(tmp_path)


@pytest.mark.parametrize("entry", [["-m", "nawaban"], [str(ROOT / "nawaban" / "cli.py")]])
def test_help_lists_only_the_tracker_verbs(entry, tmp_path):
    result = subprocess.run([sys.executable, *entry, "--help"], cwd=tmp_path, capture_output=True,
                            text=True, env={**os.environ, "PYTHONPATH": str(ROOT)}, check=True)
    listed = re.search(r"\{([a-z,-]+)\}", result.stdout).group(1).split(",")
    assert set(listed) == VERBS and len(listed) == len(VERBS)


def test_database_environment_selects_the_board(monkeypatch, tmp_path):
    primary = tmp_path / "primary.db"
    monkeypatch.setenv("NAWABAN_DB", str(primary))
    assert cli.resolve_db(None) == primary
    assert cli.main(["init"]) == 0
    assert primary.is_file()


def test_explicit_database_overrides_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("NAWABAN_DB", str(tmp_path / "environment.db"))
    explicit = tmp_path / "explicit.db"
    assert cli.main(["--db", str(explicit), "init"]) == 0
    assert explicit.is_file()
    assert not (tmp_path / "environment.db").exists()


def test_init_in_empty_directory_creates_new_default(tmp_path):
    assert cli.main(["init"]) == 0
    assert (tmp_path / ".nawaban/nawaban.db").is_file()


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
    assert cli.resolve_db(None).resolve() == (main / ".nawaban/nawaban.db").resolve()
    assert not (linked / ".nawaban").exists()


def test_listener_environment(monkeypatch, tmp_path):
    path = tmp_path / "board.db"
    cli.init(path)
    monkeypatch.setenv("NAWABAN_DB", str(path))
    monkeypatch.setenv("NAWABAN_BOARD_PORT", "18814")
    monkeypatch.setenv("NAWABAN_BOARD_HOST", "127.0.0.2")
    calls = []
    monkeypatch.setattr(board_view, "serve", lambda *args, **kwargs: calls.append((args, kwargs)))
    assert board_view.main([]) == 0
    assert calls == [((path, 18814), {"host": "127.0.0.2"})]
