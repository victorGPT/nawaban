"""Keep direct pytest runs and their subprocesses away from personal state."""

import os
from pathlib import Path
import shutil
import tempfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
_home = tempfile.TemporaryDirectory(prefix="nawaban-pytest-")
_bootstrap = pytest.MonkeyPatch()


def _isolate(patch, home):
    for name in tuple(os.environ):
        if name.startswith(("NAWABAN_", "TYPESAFE_")) or name.endswith(("_API_KEY", "_API_TOKEN")):
            patch.delenv(name, raising=False)
    for name in ("NAWABAN_OWNER", "TMUX", "TMUX_PANE", "HC_TERMINAL_ID", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "ANTIGRAVITY_CONVERSATION_ID", "GH_TOKEN",
                 "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"):
        patch.delenv(name, raising=False)
    patch.setenv("HOME", str(home))
    patch.setenv("XDG_CONFIG_HOME", str(home / "config"))
    patch.setenv("XDG_CACHE_HOME", str(home / "cache"))
    patch.setenv("PYTHONPATH", str(ROOT))
    patch.setenv("NAWABAN_OWNER", "ac:selftest")
    patch.setenv("CLAUDE_CODE_SESSION_ID", "selftest-session")
    patch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    patch.setenv("GIT_CONFIG_GLOBAL", os.devnull)


# Module constants may resolve Path.home() during collection, before fixtures run.
_isolate(_bootstrap, Path(_home.name))


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.chdir(tmp_path)


@pytest.fixture
def outside_tmp():
    parent = ROOT / ".pytest-repos"
    parent.mkdir(exist_ok=True)
    d = Path(tempfile.mkdtemp(dir=parent))
    yield d
    shutil.rmtree(d, ignore_errors=True)


BOARD_DEPENDENCY_THE_HOOKS_LOAD = ROOT / "board" / "node_modules" / "@vercel" / "board"


def pytest_sessionstart(session):
    if not BOARD_DEPENDENCY_THE_HOOKS_LOAD.is_dir():
        pytest.exit(f"钩子调的板 CLI 缺依赖，测试会静默变红：先跑 pnpm --dir {ROOT / 'board'} install --frozen-lockfile", returncode=2)


def pytest_unconfigure(config):
    _bootstrap.undo()
    _home.cleanup()
