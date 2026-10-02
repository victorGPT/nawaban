"""Exercise the public launcher through both legacy-directory and file symlinks."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from urllib.request import urlopen

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("file_link", [False, True])
def test_symlink_launcher_serves_selected_board(tmp_path, file_link):
    legacy = tmp_path / ".claude/foreman/workos"
    legacy.parent.mkdir(parents=True)
    legacy.symlink_to(ROOT / "nawaban", target_is_directory=True)
    launcher = legacy / "board-up.sh"
    if file_link:
        launcher = tmp_path / "board.sh"
        launcher.symlink_to(legacy / "board-up.sh")
    board = tmp_path / "selected.db"
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("NAWABAN_", "TYPESAFE_")) and k != "PYTHONPATH"}
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env.update(NAWABAN_DB=str(board), NAWABAN_BOARD_HOST="127.0.0.1",
               NAWABAN_BOARD_PORT=str(port), HOME=str(tmp_path))
    subprocess.run([sys.executable, str(ROOT / "nawaban/cli.py"), "init"],
                   cwd=tmp_path, env=env, check=True, capture_output=True)
    try:
        started = subprocess.run(["bash", str(launcher)], cwd=tmp_path, env=env,
                                 capture_output=True, text=True, timeout=20)
        assert started.returncode == 0, started.stdout + started.stderr
        assert "HTTP 200" in started.stdout
        with urlopen(f"http://127.0.0.1:{port}/api/board", timeout=5) as response:
            assert json.load(response)["columns"] is not None
        with urlopen(f"http://127.0.0.1:{port}/api/modules", timeout=5) as response:
            assert json.load(response)["tasks"] == []
    finally:
        subprocess.run(["bash", str(launcher), "stop"], cwd=tmp_path, env=env,
                       capture_output=True, timeout=10)
