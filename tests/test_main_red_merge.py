"""While a push-triggered workflow on main is red, merges are frozen except fix PRs."""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nawaban import guard  # noqa: E402

PR_URL = "https://github.com/ac/repo/pull/1"
MERGE = "gh pr merge 1 -R ac/repo --squash"


def run(workflow, conclusion, event="push", n=1):
    return {"workflowName": workflow, "status": "completed", "conclusion": conclusion,
            "headSha": f"{n:040x}", "url": f"https://github.com/ac/repo/actions/runs/{n}",
            "createdAt": f"2026-10-16T0{n}:00:00Z", "event": event}


def merge(monkeypatch, tmp_path, runs, title="fix: app", labels=()):
    def github(args, *_):
        if args[:2] == ["pr", "view"]:
            return {"statusCheckRollup": [{"name": "t", "status": "COMPLETED", "conclusion": "SUCCESS"}],
                    "headRefOid": "a" * 40, "url": PR_URL, "title": title,
                    "labels": [{"name": n} for n in labels]}
        if args[:2] == ["run", "list"]:
            assert args[2:4] == ["-R", "github.com/ac/repo"] and "event" in args[args.index("--json") + 1]
            if isinstance(runs, Exception):
                raise runs
            return {"runs": runs}
        return {"ahead_by": 0, "commits": []}
    monkeypatch.setattr(guard, "_github", github)
    return guard.judge_merge(MERGE, str(tmp_path))


def test_red_push_workflow_blocks_and_names_it_with_link(monkeypatch, tmp_path):
    code, msg = merge(monkeypatch, tmp_path, [run("deploy", "success", n=2), run("test", "failure", n=1)])
    assert code == 2 and "main 红着" in msg
    assert "test: https://github.com/ac/repo/actions/runs/1" in msg and "deploy" not in msg
    assert "Revert" in msg and "main-fix" in msg and "重跑" in msg


def test_newer_success_on_same_workflow_unfreezes(monkeypatch, tmp_path):
    assert merge(monkeypatch, tmp_path, [run("test", "success", n=2), run("test", "failure", n=1)]) == (0, "")


def test_red_runs_from_schedule_or_workflow_run_do_not_freeze(monkeypatch, tmp_path):
    runs = [run("probe", "failure", "schedule", 3), run("verify", "failure", "workflow_run", 2),
            run("test", "success", n=1)]
    assert merge(monkeypatch, tmp_path, runs) == (0, "")


def test_cancelled_latest_run_does_not_hide_earlier_failure(monkeypatch, tmp_path):
    code, msg = merge(monkeypatch, tmp_path, [run("test", "cancelled", n=2), run("test", "failure", n=1)])
    assert code == 2 and "actions/runs/1" in msg


def test_revert_title_merges_while_main_is_red(monkeypatch, tmp_path):
    assert merge(monkeypatch, tmp_path, [run("test", "failure")], title='Revert "feat: x"') == (0, "")


def test_main_fix_label_merges_while_main_is_red(monkeypatch, tmp_path):
    assert merge(monkeypatch, tmp_path, [run("test", "failure")], labels=("bug", "main-fix")) == (0, "")


def test_failed_run_list_query_blocks(monkeypatch, tmp_path):
    code, msg = merge(monkeypatch, tmp_path, guard.Unverified("GitHub query failed (exit 1)"))
    assert code == 2 and "GitHub query failed" in msg


def test_same_named_workflows_are_told_apart_by_id(monkeypatch, tmp_path):
    runs = [{**run("CI", "success", n=2), "workflowDatabaseId": 20},
            {**run("CI", "failure", n=1), "workflowDatabaseId": 10}]
    code, msg = merge(monkeypatch, tmp_path, runs)
    assert code == 2 and "CI: https://github.com/ac/repo/actions/runs/1" in msg


def test_rerun_in_progress_stays_frozen(monkeypatch, tmp_path):
    rerun = {**run("test", "", n=2), "status": "in_progress", "attempt": 2, "workflowDatabaseId": 10}
    code, msg = merge(monkeypatch, tmp_path, [rerun, {**run("test", "success", n=1), "workflowDatabaseId": 10}])
    assert code == 2 and "main 上 test 正在重跑，等结论" in msg and "actions/runs/2" in msg


@pytest.mark.parametrize("runs", [
    [{"workflowName": "test", "status": "completed", "conclusion": "failure", "event": "push"}],
    [{}],
    [{"event": "push", "workflowName": "CI", "conclusion": "failure"}],
])
def test_malformed_run_list_blocks(monkeypatch, tmp_path, runs):
    code, msg = merge(monkeypatch, tmp_path, runs)
    assert code == 2 and "形状不对" in msg
