"""Resolve static assets in an installed package or a source checkout."""
import os
from pathlib import Path


def web_dist() -> Path:
    override = os.environ.get("NAWABAN_WEB_DIST")
    if override:
        return Path(override).expanduser()
    package = Path(__file__).resolve().parent
    installed = package / "webui_dist"
    return installed if installed.is_dir() else package / "webui" / "dist"
