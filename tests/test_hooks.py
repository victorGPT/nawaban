import json, os, subprocess
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "leader-index.sh"


def _run(tmp_path, terminals, branch=None):
    bin_ = tmp_path / "bin"; bin_.mkdir(parents=True, exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'terminals': terminals})}'\n"); (bin_ / "hc").chmod(0o755)
    proj = tmp_path / "p"; (proj / "docs/agents").mkdir(parents=True, exist_ok=True)
    (proj / "docs/agents/leader.md").write_text("规矩正文\n")
    if branch:
        subprocess.run(["git", "init", "-q", "-b", branch, str(proj)], check=True)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1", "CLAUDE_PROJECT_DIR": str(proj)}
    return subprocess.run(["sh", str(HOOK)], cwd=tmp_path, env=env, capture_output=True, text=True).stdout


def test_a_leader_gets_the_repositorys_leader_rules(tmp_path):
    assert "规矩正文" in _run(tmp_path, [{"address": "t1", "parent": None}])


def test_a_worker_gets_nothing(tmp_path):
    assert _run(tmp_path, [{"address": "t1", "parent": "t0"}]) == ""


def test_a_leader_is_told_when_the_repository_is_off_main(tmp_path):
    assert "不在 main" in _run(tmp_path, [{"address": "t1", "parent": None}], branch="fix/x")
    assert "不在 main" not in _run(tmp_path / "m", [{"address": "t1", "parent": None}], branch="main")
