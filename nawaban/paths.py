"""Resolve per-user state and static assets in an installed package or a source checkout."""
import os
from pathlib import Path


def state_dir() -> Path:
    """Per-user runtime state: session registry, reconciliation reports, main CI status."""
    return Path(os.environ.get("NAWABAN_STATE_DIR") or Path.home() / ".local/state/nawaban").expanduser()


def web_dist() -> Path:
    override = os.environ.get("NAWABAN_WEB_DIST")
    if override:
        return Path(override).expanduser()
    package = Path(__file__).resolve().parent
    installed = package / "webui_dist"
    return installed if installed.is_dir() else package / "webui" / "dist"
