"""Exercise the installed Bash hook with a fake read-only GitHub CLI."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])


def test_merge_gate() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        gh = root / "gh"
        gh.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "with open(os.environ['GH_CALLS'], 'a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "scenario = os.environ['GH_SCENARIO']\n"
            "if scenario == 'error': sys.exit(1)\n"
            "if scenario == 'malformed': print('not JSON'); sys.exit(0)\n"
            "if scenario == 'invalid_bytes': sys.stdout.buffer.write(b'\\xff'); sys.exit(0)\n"
            "if sys.argv[1:3] == ['pr', 'view']:\n"
            " check = {'name': 'Test', 'status': 'COMPLETED', 'conclusion': 'SUCCESS'}\n"
            " if scenario == 'pending': check.update(status='IN_PROGRESS', conclusion='')\n"
            " if scenario in ('FAILURE', 'CANCELLED', 'SKIPPED', 'NEUTRAL'): check['conclusion'] = scenario\n"
            " if scenario == 'status': check = {'context': 'legacy CI', 'state': 'SUCCESS'}\n"
            " if scenario == 'status_pending': check = {'context': 'legacy CI', 'state': 'PENDING'}\n"
            " print(json.dumps({'statusCheckRollup': [] if scenario == 'empty' else [check],\n"
            "   'headRefOid': 'a' * 40, 'url': 'https://github.com/ac/repo/pull/1'}))\n"
            "elif sys.argv[1] == 'api':\n"
            " assert sys.argv[-1] == 'repos/ac/repo/compare/main...' + 'a' * 40, sys.argv\n"
            " print(json.dumps({'base_commit': {'sha': 'b' * 40},\n"
            "   'merge_base_commit': {'sha': ('c' if scenario == 'behind' else 'b') * 40}}))\n"
            "else: raise AssertionError(sys.argv)\n"
        )
        gh.chmod(0o755)
        calls = root / "calls"
        env = {k: v for k, v in os.environ.items()
               if k not in {"FOREMAN_OWNER", "CLAUDE_CODE_SESSION_ID", "TMUX", "TMUX_PANE"}}
        env.update(FOREMAN_OWNER="ac:test", PATH=f"{tmp}:{os.environ['PATH']}", GH_CALLS=str(calls))

        def check(command: str, scenario: str = "success", expected: int = 0,
                  needle: str = "", identity: bool = True) -> list[list[str]]:
            calls.write_text("")
            current = {**env, "GH_SCENARIO": scenario}
            if not identity:
                current.pop("FOREMAN_OWNER")
            result = subprocess.run(
                [sys.executable, str(FOREMAN / "nawaban/guard.py")],
                input=json.dumps({"tool_name": "Bash", "cwd": tmp,
                                  "tool_input": {"command": command}}),
                capture_output=True, text=True, env=current,
            )
            assert result.returncode == expected and needle in result.stderr, (command, scenario, result)
            return [json.loads(line) for line in calls.read_text().splitlines()]

        merge = "gh pr merge 1 --squash"
        check(merge, "pending", 2, "Test")
        for state in ("FAILURE", "CANCELLED", "NEUTRAL"):
            check(merge, state, 2, state)
        # Preserve the current source snapshot's explicit SKIPPED allowance.
        assert len(check(merge, "SKIPPED")) == 2
        check(merge, "status_pending", 2, "legacy CI")
        check(merge, "behind", 2, "gh pr update-branch")
        for scenario in ("empty", "error", "malformed", "invalid_bytes"):
            check(merge, scenario, 2, "merge gate")
        assert len(check(merge)) == 2
        assert len(check(merge + " # merge after checks")) == 2
        assert len(check(merge + " --body '#'")) == 2
        assert len(check(merge, "status")) == 2
        assert check(merge, "pending", identity=False) == []
        for command in ("gh pr view 1", "gh pr checks 1", "echo 'gh pr merge 1'", "git push origin main",
                        "cat <<'EOF'\ngh pr merge 1\nEOF\n"):
            assert check(command, "pending") == []
        for command in ("rtk gh pr merge 1 --auto", "rtk proxy gh pr merge --squash 1",
                        "command gh pr merge 1", "/opt/homebrew/bin/gh pr merge 1",
                        "gh -Rac/repo pr merge 1", "gh pr --repo=ac/repo merge 1",
                        "gh pr -R ac/repo merge 1",
                        "gh \\\npr merge 1"):
            check(command, "pending", 2, "Test")
        query = check("gh -R ac/repo pr merge 1 --body 'text gh pr merge 2' --squash")[0]
        assert query[:5] == ["pr", "view", "-R", "ac/repo", "1"], query
        query = check("gh pr merge https://github.com/ac/repo/pull/1 --repo=ac/repo --squash")[0]
        assert "--repo=ac/repo" in query
        assert len(check("gh pr merge --squash")) == 2
        for command in ("cd /tmp && gh pr merge 1", "gh pr update-branch 1; gh pr merge 1",
                        "GH_REPO=other/repo gh pr merge 1", "env GH_REPO=other/repo gh pr merge 1",
                        "gh pr merge $PR", "gh pr merge 1\necho '",
                        "gh pr checks 1 --watch  # wait\ngh pr merge 1 --squash",
                        "echo '<<EOF'\ngh pr merge 1", "echo hi # <<EOF\ngh pr merge 1"):
            assert check(command, expected=2, needle="单独运行") == []
    print("merge gate OK")


if __name__ == "__main__":
    test_merge_gate()
