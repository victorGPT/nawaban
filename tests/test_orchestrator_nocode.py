"""NAWABAN-ORCH-NOCODE: in the orchestrator's terminal a PreToolUse hook refuses writes to repository files and lets everything else through."""

import json, os, shutil, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "hooks" / "orchestrator-nocode.sh"


def terminal(tmp_path, role):
    bin_ = tmp_path / "bin"; bin_.mkdir(exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'labels': {'role': role}, 'pid': os.getpid()})}'\n"); (bin_ / "hc").chmod(0o755)
    repo = tmp_path / "repo"; (repo / "src").mkdir(parents=True, exist_ok=True)
    (repo / "src" / "a.py").write_text("x = 1\n")
    (repo / ".gitignore").write_text("notes/\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    scratch = tmp_path / "scratch"; scratch.mkdir(exist_ok=True)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1", "TMPDIR": str(scratch),
           "NAWABAN_BOARD_DIR": str(tmp_path / "board")}

    def call(tool, tool_input, **extra):
        payload = {"tool_name": tool, "tool_input": tool_input, "cwd": str(repo), "session_id": "s", **extra}
        return subprocess.run(["sh", str(HOOK)], input=json.dumps(payload), env=env, capture_output=True, text=True)
    return call, repo, scratch


def refused(r):
    return r.returncode == 2 and "nawaban dispatch" in r.stderr


def test_the_orchestrator_cannot_edit_a_repository_file(tmp_path):
    call, repo, _ = terminal(tmp_path, "orchestrator")
    for tool, key in (("Edit", "file_path"), ("Write", "file_path"), ("MultiEdit", "file_path"), ("NotebookEdit", "notebook_path")):
        assert refused(call(tool, {key: str(repo / "src" / "a.py")})), tool
    assert refused(call("Write", {"file_path": "src/new/b.py"}))


def test_the_orchestrator_may_write_scratch_board_and_ignored_files(tmp_path):
    call, repo, scratch = terminal(tmp_path, "orchestrator")
    for path in (scratch / "plan.md", tmp_path / "board" / "x.json", repo / "notes" / "n.md", tmp_path / "elsewhere.md", "/tmp/x.md"):
        assert call("Write", {"file_path": str(path)}).returncode == 0, path


def test_the_orchestrator_cannot_write_the_repository_from_the_shell(tmp_path):
    call, repo, _ = terminal(tmp_path, "orchestrator")
    for cmd in ("git commit -m x", "cd sub && git -C . commit -am x", "git -c a=b push origin HEAD", "git apply p.diff",
                "echo x > src/a.py", "echo x >> README.md", "cat > src/b.py <<'EOF'\nprint(1)\nEOF", "sed -i '' s/1/2/ src/a.py",
                "sed -i.bak s/1/2/ src/a.py", "echo y | tee src/c.py", "apply_patch <<'EOF'\n*** Begin Patch\nEOF",
                "FOO=1 git commit -m x", "cd src && echo x > ../README.md", "echo x >& README.md",
                "(cd /tmp); echo x > README.md", "hc send t1 'example <<EOF'\ngit commit -m x", "cat <<< hi\ngit commit -m x",
                "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: /tmp/plan.md\n*** Move to: README.md\n*** End Patch\nEOF"):
        assert refused(call("Bash", {"command": cmd})), cmd


def test_the_orchestrator_keeps_its_own_commands(tmp_path):
    call, repo, scratch = terminal(tmp_path, "orchestrator")
    for cmd in ("gh pr merge 12 --squash", "gh pr view 12", "hc send t1 '回报：完成'", "git status", "git log -1", "git pull --ff-only",
                "node board/src/cli.ts event 9 --kind note --body '下一步：git commit，再 sed -i 改 a.py > src/a.py'",
                "nawaban dispatch X --body \"$(cat <<'EOF'\ngit commit -m x\necho x > src/a.py\nEOF\n)\"",
                "ls 2>/dev/null >&2", "echo x > /dev/null", f"echo x > {scratch}/o.txt", "rg 'sed -i' src", "cat src/a.py | head", "gh pr view 12 # > README.md", "hc send t1 \"$(printf \"状态 > README.md\")\"", "hc send t1 \"$(cat <<'EOF'\n示例 \"echo x > README.md\"\nEOF\n)\"",
                "hc send t1 '>'", "rg '>' src", "node cli.ts event 9 --body=\"a > src/a.py\"", f"cd {scratch} && echo x > plan.md",
                f"apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: {scratch}/n.md\n+x\n*** End Patch\nEOF"):
        r = call("Bash", {"command": cmd})
        assert r.returncode == 0, (cmd, r.stderr)


def test_a_codex_patch_to_a_repository_file_is_refused(tmp_path):
    call, repo, scratch = terminal(tmp_path, "orchestrator")
    patch = lambda p: {"command": f"*** Begin Patch\n*** Update File: {p}\n@@\n-x = 1\n+x = 2\n*** End Patch\n"}
    assert refused(call("apply_patch", patch("src/a.py")))
    assert call("apply_patch", patch(str(scratch / "a.py"))).returncode == 0


def test_a_subagent_of_the_orchestrator_may_write(tmp_path):
    call, repo, _ = terminal(tmp_path, "orchestrator")
    assert call("Edit", {"file_path": str(repo / "src" / "a.py")}, agent_id="a1", agent_type="general-purpose").returncode == 0
    assert call("Bash", {"command": "git commit -m x"}, agent_id="a1").returncode == 0


def test_a_worker_terminal_is_not_affected(tmp_path):
    call, repo, _ = terminal(tmp_path, "worker")
    assert call("Edit", {"file_path": str(repo / "src" / "a.py")}).returncode == 0
    assert call("Bash", {"command": "git commit -m x && git push"}).returncode == 0
