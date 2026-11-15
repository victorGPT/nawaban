import json, os, subprocess
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "leader-index.sh"


def _run(tmp_path, labels, branch=None, rules_file="orchestrator.md"):
    bin_ = tmp_path / "bin"; bin_.mkdir(parents=True, exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'labels': labels})}'\n"); (bin_ / "hc").chmod(0o755)
    proj = tmp_path / "p"; (proj / "docs/agents").mkdir(parents=True, exist_ok=True)
    (proj / f"docs/agents/{rules_file}").write_text("规矩正文\n")
    if branch:
        subprocess.run(["git", "init", "-q", "-b", branch, str(proj)], check=True)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1", "CLAUDE_PROJECT_DIR": str(proj)}
    return subprocess.run(["sh", str(HOOK)], cwd=tmp_path, env=env, capture_output=True, text=True).stdout


def test_a_declared_orchestrator_gets_the_repositorys_orchestrator_rules_or_the_older_leader_md(tmp_path):
    assert "规矩正文" in _run(tmp_path, {"role": "orchestrator"})
    assert "规矩正文" in _run(tmp_path / "old", {"role": "orchestrator"}, rules_file="leader.md")


def test_an_undeclared_terminal_gets_nothing(tmp_path):
    assert _run(tmp_path, {"where": "roubao"}) == ""
    assert _run(tmp_path / "w", {"role": "worker"}) == ""


def test_an_orchestrator_is_told_when_the_repository_is_off_main(tmp_path):
    assert "不在 main" in _run(tmp_path, {"role": "orchestrator"}, branch="fix/x")
    assert "不在 main" not in _run(tmp_path / "m", {"role": "orchestrator"}, branch="main")
