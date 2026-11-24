"""install.sh runs to its end in a UTF-8 locale, where bash reads CJK letters after $name into the name."""

import os
import subprocess
from pathlib import Path

INSTALL = Path(__file__).resolve().parents[1] / "install.sh"
STUBS = {"uname": "echo Darwin", "node": "exit 0", "pnpm": "exit 0", "claude": "exit 0", "launchctl": "exit 0", "curl": "exit 0"}


def test_install_runs_through_in_a_utf8_locale(tmp_path):
    bin_dir = tmp_path / "stubs"
    bin_dir.mkdir()
    for name, body in STUBS.items():
        (bin_dir / name).write_text(f"#!/bin/sh\n{body}\n")
        (bin_dir / name).chmod(0o755)
    board = tmp_path / "board"
    board.mkdir()
    (board / "web-token").write_text("t\n")
    env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp_path), "LC_ALL": "C.UTF-8",
           "NAWABAN_BOARD_DIR": str(board), "NAWABAN_BIN_DIR": str(tmp_path / "bin")}
    r = subprocess.run(["bash", str(INSTALL)], env=env, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "启动 board 服务 com.nawaban.board（launchd，127.0.0.1:4100）" in r.stdout
    assert "装好了。board 在 " + str(board) + "，网页在 http://127.0.0.1:4100/。" in r.stdout
    assert (tmp_path / "Library" / "LaunchAgents" / "com.nawaban.board.plist").exists()
