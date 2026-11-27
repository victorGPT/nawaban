"""NAWABAN-ORCH-GUARD: in the orchestrator's terminal a PreToolUse hook lets orchestration commands through and refuses reading or searching code and data."""

import json, os, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "orchestrator-allowlist.sh"


def terminal(tmp_path, role, outside):
    bin_ = tmp_path / "bin"; bin_.mkdir(exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'labels': {'role': role}, 'pid': os.getpid()})}'\n"); (bin_ / "hc").chmod(0o755)
    repo = outside / "repo"
    for d in ("apps/web", "docs/agents", "board"):
        (repo / d).mkdir(parents=True, exist_ok=True)
    (repo / "apps/web/a.ts").write_text("x\n"); (repo / "docs/agents/orchestrator.md").write_text("规矩\n"); (repo / "AGENTS.md").write_text("a\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    scratch = tmp_path / "scratch"; scratch.mkdir(exist_ok=True)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1", "TMPDIR": str(scratch),
           "NAWABAN_BOARD_DIR": str(tmp_path / "board")}

    def call(tool, tool_input, **extra):
        payload = {"tool_name": tool, "tool_input": tool_input, "cwd": str(repo), "session_id": "s", **extra}
        return subprocess.run(["sh", str(HOOK)], input=json.dumps(payload), env=env, capture_output=True, text=True)
    return call, repo, scratch


def refused(r):
    return r.returncode == 2 and "派 worker 查" in r.stderr


def test_the_orchestrator_cannot_search_code_and_is_told_to_send_a_worker(tmp_path, outside_tmp):
    call, repo, _ = terminal(tmp_path, "orchestrator", outside_tmp)
    for cmd in ("rg apps/", "rg foo apps/ packages/", "cat apps/web/a.ts", "grep -r x .", "ssh rbox4 ls", "ssh rb-app 'tail log'",
                "git show HEAD", "git diff", "gh api repos/x/y", "gh pr diff 3", "nawaban show X && rg apps/", "nawaban show X | rg y apps/",
                "nawaban event 9 note \"$(rg apps/)\"", "hc send t1 \"`cat apps/web/a.ts`\"", "ls board", "python3 -c 1",
                "cat apps/web/*.ts", "cd apps/web && cat a.ts", "grep -f apps/web/a.ts </dev/null", "nawaban show X | grep y a.ts",
                "grep -R secret", "cat 123", "jq -f prog.jq", "sort -o out.txt", "nawaban show X | grep --include=*.ts -r x",
                "cat <<EOF\n$(cat apps/web/a.ts)\nEOF",
                "grep -e x apps/web/a.ts", "grep -ex apps/web/a.ts", "cat <<EOF\n'$(cat apps/web/a.ts)'\nEOF", "true # it's\necho $(cat apps/web/a.ts) '",
                "jq . < apps/web/a.ts", "git log -1 -p", "git log --patch", "git log -L1,2:apps/web/a.ts", "git log -Sfoo", "git log -5 --dd", "git log -5 -c", "cd docs/agents && cat < ../../apps/web/a.ts", "node apps/web/a.js", "python3 scripts/x.py", "git pull", "git status -v", "git status --verbose", "git status -vv", "gh --repo o/r api x",
                "true # <<true\ncat apps/web/a.ts\ntrue", "echo '<<EOF'\ncat apps/web/a.ts\nEOF"):
        assert refused(call("Bash", {"command": cmd})), cmd
    assert refused(call("Read", {"file_path": str(repo / "apps/web/a.ts")}))
    assert refused(call("Grep", {"pattern": "x", "path": "apps"}))
    assert refused(call("Grep", {"pattern": "x"}))
    assert refused(call("Glob", {"pattern": "**/*.ts"}))


def test_the_orchestrator_keeps_its_orchestration_commands(tmp_path, outside_tmp):
    call, repo, scratch = terminal(tmp_path, "orchestrator", outside_tmp)
    for cmd in ("nawaban status", "nawaban show X | head -20", "hc ls --json | jq .", "gh pr view 12", "gh issue list --state open",
                "git status", "git -C ../x log --oneline -5", "cd ../x && git status", "FOO=1 nawaban status 2>/dev/null",
                "nawaban dispatch X --body \"$(cat <<'EOF'\nrg apps/ 查一下\nEOF\n)\"", "hc send t1 '回报：rg apps/ 已派'",
                "hc send t1 '请执行 `rg apps/` 并回报'", "nawaban dispatch X --body '检查 $(rg apps/)'", "nawaban list | sort -k 2 | head -n 5", "hc ls --json | jq -r '.[].id' | grep -c t1",
                "nawaban show X | tail -20 | grep -iE 'a|b'", "hc ls --json | jq . 2>/dev/null", "git log --oneline --stat -3",
                "nawaban show X 2>&1 | head -n 5", "git log -n 3 --format=%h --since=2.days -- docs", "git log origin/main..HEAD --oneline", "nawaban status < /dev/null",
                "node ~/.nawaban/plugin/hooks/route.mjs", "node ~/.nawaban/plugin/board/src/cli.ts event X --kind ask --body 'A 还是 B'", "python3 ~/.nawaban/plugin/nawaban/cli.py show '#12'",
                "GH_TOKEN=$(gh auth token --user victorGPT) gh pr merge 12 --squash --match-head-commit abc", "gh pr checks 12", "gh --repo o/r pr view 12", "gh -R o/r issue list", "gh --repo=o/r pr list",
                "git -C ~/.nawaban/plugin pull --ff-only && sh ~/.nawaban/plugin/herdr/install-mod.sh", "scripts/merge.sh 12",
                "git worktree remove ../wt-x", "git status -sb", "git status --porcelain=v1", "python3 ~/.nawaban/plugin/nawaban/cli.py backup"):
        r = call("Bash", {"command": cmd})
        assert r.returncode == 0, (cmd, r.stderr)
    for path in (repo / "docs/agents/orchestrator.md", repo / "AGENTS.md", repo / "CLAUDE.md", scratch / "plan.md", tmp_path / "board" / "x.json"):
        assert call("Read", {"file_path": str(path)}).returncode == 0, path
    assert call("Grep", {"pattern": "x", "path": "docs/agents"}).returncode == 0
    assert call("Glob", {"pattern": "docs/agents/*.md"}).returncode == 0


def test_a_subagent_of_the_orchestrator_may_search(tmp_path, outside_tmp):
    call, repo, _ = terminal(tmp_path, "orchestrator", outside_tmp)
    assert call("Bash", {"command": "rg apps/"}, agent_id="a1").returncode == 0
    assert call("Read", {"file_path": str(repo / "apps/web/a.ts")}, agent_id="a1").returncode == 0


def test_a_worker_terminal_is_not_affected(tmp_path, outside_tmp):
    call, repo, _ = terminal(tmp_path, "worker", outside_tmp)
    assert call("Bash", {"command": "rg apps/"}).returncode == 0
    assert call("Read", {"file_path": str(repo / "apps/web/a.ts")}).returncode == 0
