"""`json board` in a repository whose tracker is GitHub issues (spec NAWABAN-INDEX, Data mapping)."""

import json
import subprocess
from pathlib import Path

import pytest

from nawaban import cli

REAL_GH_ISSUES = cli._gh_issues
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "gh_issues.json").read_text())


@pytest.fixture
def board(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "roubao"
    (repo / "docs" / "agents").mkdir(parents=True)
    (repo / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: GitHub\n\nUse gh.\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(repo)
    monkeypatch.setattr(cli, "_gh_issues", lambda root: FIXTURE)

    def board():
        code = cli.main(["json", "board"])
        out = json.loads(capsys.readouterr().out)
        assert code == 0, out
        return {t["id"]: t | {"column": c["key"]} for c in out["columns"] for t in c["tasks"]}
    return board


def test_closed_is_done_claimed_is_in_progress_else_open_and_not_planned_is_left_out(board):
    tasks = board()
    assert {i: t["column"] for i, t in tasks.items()} == {
        "#275": "in_progress", "#307": "in_progress", "#239": "open", "#294": "open", "#292": "open", "#301": "open",
        "#237": "done", "#296": "done"}
    assert tasks["#275"]["title"] == "角色方向分不清（示例）"
    assert tasks["#275"]["status"] == "in_progress"


def test_parent_comes_from_the_title_or_the_body(board):
    tasks = board()
    assert tasks["#239"]["parent"] == "#236"  # title （#236-C） and body 属于 #236
    assert tasks["#237"]["parent"] == "#236"  # title (#236-A) only
    assert tasks["#296"]["parent"] == "#293"  # body Part of #293
    assert tasks["#294"]["parent"] == "#289"  # body Parent: #289
    assert tasks["#275"]["parent"] is None


@pytest.mark.parametrize("fail", [FileNotFoundError("gh"), subprocess.CompletedProcess([], 1, "", "not logged in")])
def test_gh_missing_or_failing_is_an_error(board, monkeypatch, capsys, fail):
    monkeypatch.setattr(cli, "_gh_issues", REAL_GH_ISSUES)
    real_run = subprocess.run  # git, for detection

    def run(args, **kw):
        if args[0] != "gh":
            return real_run(args, **kw)
        if isinstance(fail, Exception):
            raise fail
        return fail
    monkeypatch.setattr(cli.subprocess, "run", run)
    assert cli.main(["json", "board"]) == 1
    assert "error" in json.loads(capsys.readouterr().out)


def test_gh_is_asked_for_open_issues_and_those_closed_in_the_last_48_hours(monkeypatch):
    monkeypatch.setattr(cli.time, "time", lambda: ts("2026-11-07T12:00:00Z"))
    calls = []
    monkeypatch.setattr(cli.subprocess, "run",
                        lambda args, **kw: calls.append(args) or subprocess.CompletedProcess(args, 0, "[]", ""))
    assert cli._gh_issues(Path(".")) == []
    assert [c[3:7] for c in calls] == [["--state", "open", "--limit", "1000"],
                                      ["--state", "closed", "--search", "closed:>=2026-11-05T12:00:00Z"]]
    assert all("stateReason" in c[-1] and "comments" in c[-1] for c in calls)


def test_a_repository_tracked_on_the_board_never_asks_gh(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "other"
    (repo / "docs" / "agents").mkdir(parents=True)
    (repo / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: nawaban board\n\nGitHub is not used.\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(repo)
    monkeypatch.setattr(cli, "_gh_issues", lambda root: pytest.fail("asked gh"))
    db = tmp_path / ".nawaban" / "nawaban.db"
    assert cli.main(["--db", str(db), "init"]) == 0
    capsys.readouterr()
    assert cli.main(["--db", str(db), "json", "board"]) == 0
    assert all(c["tasks"] == [] for c in json.loads(capsys.readouterr().out)["columns"])


def ts(iso):
    from datetime import datetime
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def test_progress_decision_and_terminal_come_from_the_latest_prefixed_comments(board):
    t = board()["#275"]
    assert t["progress"] == {"body": "人标写回。\n核查略。", "at": ts("2026-11-06T18:59:18Z")}
    assert t["decision"] == {"at": ts("2026-11-06T17:58:43Z"), "verdict": "改动不合 → 停在这里，理由：打平。"}
    assert t["terminal"] == "t52"
    assert t["session"] == "gh-275（hc t52）"  # the claimant holds it: the panel reads a held task by its session
    assert t["claimed_at"] == ts("2026-11-06T14:37:48Z")
    assert (t["created_at"], t["active_at"]) == (ts("2026-11-06T14:28:01Z"), ts("2026-11-06T18:59:18Z"))
    assert (t["open_blockers"], t["blocked_by"], t["project"]) == (0, [], "roubao")


def test_a_prefix_may_carry_markdown_and_a_who_which_stays_in_the_body(board):
    tasks = board()
    assert tasks["#292"]["decision"]["verdict"] == "（owner 2026-11-07，经 roubao-e8 转达）审过，可以合。"
    assert tasks["#292"]["progress"]["body"] == "等合并。"  # ## 进展：
    assert tasks["#301"]["progress"]["body"] == "首卡压到目标内。"  # **进展**：
    assert tasks["#301"]["decision"]["verdict"] == "(roubao-e8)合并标准见正文。"


def test_an_issue_without_prefixed_comments_has_none_of_them(board):
    t = board()["#239"]
    assert (t["progress"], t["decision"], t["terminal"], t["session"], t["claimed_at"]) == (None,) * 5
    assert t["active_at"] == ts("2026-11-05T12:00:00Z")


def test_needs_info_waits_on_the_latest_progress_next_step_else_on_you(board):
    tasks = board()
    assert tasks["#307"]["waiting"] == "等 owner 对设计 B 拍板；另开小卡"
    assert tasks["#239"]["waiting"] == "等你"  # labelled, no 进展：
    assert tasks["#275"]["waiting"] is None  # its 下一步：等 owner… says nothing without the label


def test_a_closed_issue_is_done_at_its_close(board):
    t = board()["#296"]
    assert t["done_at"] == ts("2026-11-06T21:00:00Z")
    assert t["terminal"] == "t12" and t["session"] is None
    assert "progress" not in t and "waiting" not in t  # like the board: only open tasks carry these
