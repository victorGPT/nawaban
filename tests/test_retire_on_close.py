"""Closing an issue retires the worker dispatched to it (ticket NAWABAN-RETIRE-ON-CLOSE)."""

import json
import os
import subprocess
from pathlib import Path

import pytest

from nawaban import cli
from nawaban.cli import marker


def _comment(kind, body, terminal=None):
    return {"body": f"x：{body}\n\n" + marker({"v": 1, "kind": kind, "body": body, "terminal": terminal})}


def _dispatched(addr):
    return _comment("note", f"派给 hc {addr}（worktree /w，回报给 t1）\n验收：x")


def _git(*args):
    subprocess.run(["git", *args], check=True, capture_output=True)


@pytest.fixture
def roubao(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "roubao"
    (repo / "docs" / "agents").mkdir(parents=True)
    (repo / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    _git("init", "-q", "-b", "main", str(repo))
    _git("-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "add", ".")
    _git("-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    monkeypatch.chdir(repo)
    monkeypatch.setenv("NAWABAN_BOARD_DIR", str(tmp_path / "board"))
    monkeypatch.setenv("HC_TERMINAL_ID", "t1")
    s = type("S", (), {})()
    s.repo, s.terminals, s.issues, s.roles, s.killed, s.searched, s.unreachable = repo, [], [], {"t1": "orchestrator"}, [], [], set()
    real_run = subprocess.run

    def run(args, **kw):
        if args[0] == "hc":
            if args[1] == "kill":
                s.killed.append(args[2])
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[1] == "get" and args[2] in s.unreachable:
                return subprocess.CompletedProcess(args, 1, "", "timeout")
            out = {"terminals": s.terminals} if args[1] == "ls" else {"address": args[2], "labels": {"role": s.roles.get(args[2])} if s.roles.get(args[2]) else {}}
            return subprocess.CompletedProcess(args, 0, json.dumps(out), "")
        if args[0] != "gh":
            return real_run(args, **kw)
        if args[1:3] == ["issue", "list"]:
            addr = args[args.index("--search") + 1].split()[0]
            s.searched.append(addr)
            s.search_env = kw.get("env")
            hits = [i for i in s.issues if any(addr in c["body"] for c in i["comments"])]
            return subprocess.CompletedProcess(args, 0, json.dumps(hits), "")
        return subprocess.CompletedProcess(args, 0, "tok" if args[1:3] == ["auth", "token"] else "", "")
    monkeypatch.setattr(subprocess, "run", run)

    def worker(addr, status="done"):
        wt = repo.parent / f"roubao-{addr}"
        _git("-C", str(repo), "worktree", "add", "-q", "-b", f"wt/{addr}", str(wt))
        s.terminals.append({"address": addr, "cwd": str(wt), "state": "live", "status": status})
        return wt

    def nawaban(*argv):
        code = cli.main(list(argv))
        out = capsys.readouterr()
        return code, out.out + out.err
    s.worker, s.nawaban = worker, nawaban
    return s


def _issue(n, comments, state="OPEN"):
    return {"number": n, "state": state, "comments": comments}


def test_closing_a_github_issue_retires_its_idle_worker_and_removes_its_worktree(roubao):
    wt = roubao.worker("t9")
    roubao.issues.append(_issue(950, [_dispatched("t9")]))
    code, out = roubao.nawaban("close", "#950", "--done")
    assert code == 0, out
    assert roubao.killed == ["t9"] and not wt.exists()
    assert "收 worker t9，worktree 已删" in out


def test_cancelling_retires_the_worker_too(roubao):
    roubao.worker("t9")
    roubao.issues.append(_issue(950, [_dispatched("t9")]))
    assert roubao.nawaban("close", "#950", "--cancelled")[0] == 0
    assert roubao.killed == ["t9"]


def test_a_worker_with_another_open_issue_stays(roubao):
    wt = roubao.worker("t9")
    roubao.issues += [_issue(950, [_dispatched("t9")]), _issue(951, [_dispatched("t9")])]
    code, out = roubao.nawaban("close", "#950", "--done")
    assert code == 0 and roubao.killed == [] and wt.exists()
    assert "t9 还有 #951，留着" in out


def test_a_terminal_no_dispatch_named_is_never_retired(roubao):
    roubao.worker("t5")
    roubao.issues.append(_issue(950, [_comment("claim", "owner（hc t5）", "t5")]))
    roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == []


def test_the_orchestrator_and_the_main_checkout_are_never_retired(roubao):
    roubao.worker("t4")
    roubao.roles["t4"] = "orchestrator"
    roubao.terminals.append({"address": "t1", "cwd": str(roubao.repo), "state": "live", "status": "done"})
    roubao.issues.append(_issue(950, [_dispatched("t4"), _dispatched("t1")]))
    roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == [] and "t1" not in roubao.searched


def test_a_terminal_in_a_subdirectory_of_the_main_checkout_is_never_retired(roubao):
    sub = roubao.repo / "docs"
    roubao.terminals.append({"address": "t6", "cwd": str(sub), "state": "live", "status": "done"})
    roubao.issues.append(_issue(950, [_dispatched("t6")]))
    roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == [] and sub.exists()


def test_a_worker_started_in_a_subdirectory_of_its_worktree_has_the_whole_worktree_removed(roubao):
    wt = roubao.worker("t9")
    roubao.terminals[-1]["cwd"] = str(wt / "docs")
    roubao.issues.append(_issue(950, [_dispatched("t9")]))
    roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == ["t9"] and not wt.exists()


def test_a_terminal_whose_role_cannot_be_read_is_left_alone(roubao):
    wt = roubao.worker("t9")
    roubao.unreachable.add("t9")
    roubao.issues.append(_issue(950, [_dispatched("t9")]))
    roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == [] and wt.exists()


def test_uncommitted_changes_keep_the_worktree_but_the_terminal_goes(roubao):
    wt = roubao.worker("t9")
    (wt / "half.txt").write_text("wip")
    roubao.issues.append(_issue(950, [_dispatched("t9")]))
    code, out = roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == ["t9"] and (wt / "half.txt").exists()
    assert "有没提交的改动，worktree 留着" in out


def test_a_worker_still_working_on_its_own_is_left_alone(roubao):
    wt = roubao.worker("t9", status="working")
    roubao.issues.append(_issue(950, [_dispatched("t9")]))
    roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == [] and wt.exists()


def test_an_issue_closed_on_github_without_the_close_command_is_swept_by_the_orchestrator(roubao):
    wt = roubao.worker("t9")
    roubao.worker("t8")
    roubao.issues += [_issue(950, [_dispatched("t9")], state="CLOSED"), _issue(951, [_dispatched("t8")])]
    said = cli.retire_sweep_message(roubao.repo)
    assert roubao.killed == ["t9"] and not wt.exists()
    assert said == "收 worker t9，worktree 已删"
    assert cli.retire_sweep_message(roubao.repo) is None


def test_a_repo_the_board_pushes_retires_nobody_and_says_why(roubao, tmp_path):
    roubao.worker("t9")
    roubao.issues.append(_issue(950, [_dispatched("t9")], state="CLOSED"))
    (tmp_path / "board").mkdir(exist_ok=True)
    (tmp_path / "board" / "github-sync.json").write_text(json.dumps({"repos": {"acme/roubao": "roubao"}, "push": ["acme/roubao"]}))
    assert cli.retire_finished_workers(roubao.repo) == [(True, "派发记录在板上、不推 GitHub，按 GitHub 评论认不出 worker，没收：worker 要手动收")]
    assert cli.retire_sweep_message(roubao.repo) is None
    assert roubao.killed == [] and roubao.searched == []


def test_the_search_runs_as_the_repository_account(roubao, monkeypatch):
    roubao.worker("t9")
    roubao.issues.append(_issue(950, [_dispatched("t9")]))
    monkeypatch.setattr(cli, "github_account", lambda root: "victorGPT")
    monkeypatch.setattr(cli, "_env_writing_as", lambda root, account: {**os.environ, "GH_TOKEN": f"token-of-{account}"})
    roubao.nawaban("close", "#950", "--done")
    assert roubao.search_env["GH_TOKEN"] == "token-of-victorGPT" and roubao.killed == ["t9"]


def test_github_down_retires_nobody(roubao, monkeypatch):
    roubao.worker("t9")
    real = subprocess.run
    monkeypatch.setattr(subprocess, "run", lambda args, **kw: subprocess.CompletedProcess(args, 1, "", "down") if args[:3] == ["gh", "issue", "list"] else real(args, **kw))
    code, out = roubao.nawaban("close", "#950", "--done")
    assert roubao.killed == [] and "都留着" in out


HOOK = Path(__file__).resolve().parent.parent / "hooks" / "retire-sweep.sh"


def test_the_stop_hook_stays_silent_outside_herdr(tmp_path):
    r = subprocess.run(["sh", str(HOOK)], input=json.dumps({"cwd": str(tmp_path)}), capture_output=True, text=True,
                       env={k: v for k, v in os.environ.items() if k != "HC_TERMINAL_ID"})
    assert r.returncode == 0 and r.stdout == ""
