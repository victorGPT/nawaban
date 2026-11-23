import json, os, subprocess
from pathlib import Path

from nawaban.cli import marker

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "retire-guard.sh"


def _comment(kind, body, terminal=None):
    return {"body": f"x：{body}\n\n" + marker({"v": 1, "kind": kind, "body": body, "terminal": terminal})}


DISPATCHED_TO_T9 = _comment("note", "派给 hc t9（worktree /w，回报给 t1）\n验收：x")
CLAIMED_FROM_T9 = _comment("claim", "cc-1（hc t9）", "t9")
REDISPATCHED_TO_T12 = _comment("note", "派给 hc t12（worktree /w2，回报给 t1）\n验收：x")


def _repo(tmp_path):
    repo = tmp_path / "roubao"; (repo / "docs/agents").mkdir(parents=True)
    (repo / "docs/agents/issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    return repo


def _run(tmp_path, command, issues=None, gh_exit=0, known=("t9", "w-1568")):
    repo = _repo(tmp_path)
    bin_ = tmp_path / "bin"; bin_.mkdir(exist_ok=True)
    term = json.dumps({"address": "t9", "cwd": str(repo)})
    cases = " | ".join(known)
    (bin_ / "hc").write_text(f'#!/bin/sh\ncase "$2" in {cases}) echo \'{term}\' ;; *) echo nope; exit 3 ;; esac\n')
    (tmp_path / "issues.json").write_text(json.dumps(issues or []))
    (bin_ / "gh").write_text(f'#!/bin/sh\necho "$@" >> {tmp_path}/gh.log\n'
                             f'[ {gh_exit} = 0 ] || {{ echo gh down >&2; exit {gh_exit}; }}\ncat {tmp_path}/issues.json\n')
    for b in ("hc", "gh"):
        (bin_ / b).chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}"}
    return subprocess.run(["sh", str(HOOK)], input=json.dumps({"cwd": str(repo), "tool_input": {"command": command}}),
                          env=env, capture_output=True, text=True)


def _issue(n, comments, assigned=True):
    return {"number": n, "assignees": [{"login": "shared"}] if assigned else [], "comments": comments}


def test_killing_a_worker_whose_issue_is_still_assigned_is_refused_naming_the_issue_and_both_ways_out(tmp_path):
    for i, cmd in enumerate(("hc kill t9", "hc kill w-1568", "cd x && hc kill --json t9", "hc rm t9", "if true; then hc kill t9; fi")):
        r = _run(tmp_path / str(i), cmd, [_issue(1568, [DISPATCHED_TO_T9])])
        assert r.returncode == 2 and "#1568" in r.stderr and "close <ID> --done" in r.stderr and "--release" in r.stderr, cmd


def test_a_claim_made_from_the_terminal_holds_the_issue_too(tmp_path):
    r = _run(tmp_path, "hc kill t9", [_issue(7, [CLAIMED_FROM_T9])])
    assert r.returncode == 2 and "#7" in r.stderr


def test_an_unassigned_or_redispatched_issue_lets_the_worker_go(tmp_path):
    assert _run(tmp_path / "a", "hc kill t9", [_issue(1, [DISPATCHED_TO_T9], assigned=False)]).returncode == 0
    assert _run(tmp_path / "b", "hc kill t9", [_issue(2, [DISPATCHED_TO_T9, REDISPATCHED_TO_T12])]).returncode == 0
    assert _run(tmp_path / "c", "hc kill t9", [_issue(3, [{"body": "提到 t9 的普通评论"}])]).returncode == 0


def test_an_unknown_terminal_is_let_through_without_asking_github(tmp_path):
    r = _run(tmp_path, "hc kill t404", [_issue(1, [DISPATCHED_TO_T9])])
    assert r.returncode == 0 and not (tmp_path / "gh.log").exists()


def test_github_down_lets_the_kill_through_with_a_visible_warning(tmp_path):
    r = _run(tmp_path, "hc kill t9", gh_exit=1)
    assert r.returncode == 0 and "放行" in json.loads(r.stdout)["systemMessage"]


def test_commands_that_retire_nothing_pass(tmp_path):
    for cmd in ('echo "hc kill t9"', 'echo "done; hc kill t9"', "hc ls --json", "hc kill $T", "hc send t9 'hc kill t9 later'"):
        r = _run(tmp_path / str(abs(hash(cmd))), cmd, [_issue(1, [DISPATCHED_TO_T9])])
        assert r.returncode == 0 and r.stdout == "", cmd
