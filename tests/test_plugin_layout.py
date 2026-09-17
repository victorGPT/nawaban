"""The repository loads as a plugin: manifests parse and every hook command points at a shipped script."""

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
HOOKS = json.loads((ROOT / "hooks" / "hooks.json").read_text(encoding="utf-8"))["hooks"]
COMMANDS = [h["command"] for groups in HOOKS.values() for g in groups for h in g["hooks"]]


@pytest.mark.parametrize("manifest", [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"])
def test_manifest_has_identity(manifest):
    data = json.loads((ROOT / manifest).read_text(encoding="utf-8"))
    assert data["name"] == "nawaban"
    assert data["version"] and data["description"] and data["author"]["name"]


@pytest.mark.parametrize("command", COMMANDS)
def test_hook_command_points_at_shipped_script(command):
    m = re.search(r'"\$\{CLAUDE_PLUGIN_ROOT\}/([^"]+)"', command)
    assert m, f"hook must use the plugin root: {command}"
    script = ROOT / m[1]
    assert script.is_file(), script
    if not command.startswith("python3 "):
        assert os.access(script, os.X_OK), f"{script} must be executable"


def test_retired_hooks_are_not_registered():
    joined = " ".join(COMMANDS)
    for retired in ("autosync", "inbox_hook", "done_gate"):
        assert retired not in joined


def test_branch_gate_blocks_switch_in_a_main_checkout(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    payload = json.dumps({"cwd": str(tmp_path), "tool_name": "Bash",
                          "tool_input": {"command": "git checkout -b feature"}})
    r = subprocess.run([str(ROOT / "hooks" / "foreman_branch_gate.sh")], input=payload,
                       capture_output=True, text=True, cwd=tmp_path)
    assert r.returncode == 2 and "branch gate" in r.stderr
