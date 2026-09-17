"""Keep direct pytest runs and their subprocesses away from personal state."""

import os
from pathlib import Path
import tempfile

import pytest

ROOT = Path(__file__).resolve().parents[1]
_home = tempfile.TemporaryDirectory(prefix="nawaban-pytest-")
_bootstrap = pytest.MonkeyPatch()


def _isolate(patch, home):
    for name in tuple(os.environ):
        if name.startswith(("NAWABAN_", "WORKOS_", "TYPESAFE_", "FOREMAN_")) or name.endswith(("_API_KEY", "_API_TOKEN")):
            patch.delenv(name, raising=False)
    for name in ("TMUX", "TMUX_PANE", "CLAUDE_CODE_SESSION_ID", "GH_TOKEN",
                 "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"):
        patch.delenv(name, raising=False)
    patch.setenv("HOME", str(home))
    patch.setenv("XDG_CONFIG_HOME", str(home / "config"))
    patch.setenv("XDG_CACHE_HOME", str(home / "cache"))
    patch.setenv("NAWABAN_STATE_DIR", str(home / "state"))
    patch.setenv("PYTHONPATH", str(ROOT))
    patch.setenv("FOREMAN_OWNER", "ac:selftest")
    patch.setenv("CLAUDE_CODE_SESSION_ID", "selftest-session")
    patch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    patch.setenv("GIT_CONFIG_GLOBAL", os.devnull)


# Module constants may resolve Path.home() during collection, before fixtures run.
_isolate(_bootstrap, Path(_home.name))


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.chdir(tmp_path)


def pytest_unconfigure(config):
    _bootstrap.undo()
    _home.cleanup()
