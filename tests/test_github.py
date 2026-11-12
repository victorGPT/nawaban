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
    monkeypatch.setattr(cli, "_gh_issue", lambda root, n: None)  # parents outside the fixture are not found

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
        "#264": "open", "#237": "done", "#296": "done", "#306": "done"}
    assert tasks["#275"]["title"] == "角色方向分不清（示例）"
    assert tasks["#275"]["status"] == "in_progress"


def test_an_issue_links_to_its_github_page(board):
    assert board()["#292"]["url"] == "https://github.com/example/roubao/issues/292"


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
    out = json.loads(capsys.readouterr().out)
    assert all(c["tasks"] == [] for c in out["columns"]) and "tracker" not in out


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
    assert tasks["#301"]["progress"]["body"] == "首卡压到目标内。下一步：投机路径也重排。"  # **进展**：
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


def test_the_board_says_it_comes_from_github_even_with_no_issues(board, monkeypatch, capsys):
    # the panel reads GitHub at most once a minute; it tells such a board by this, not by its ids
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [])
    assert cli.main(["json", "board"]) == 0
    assert json.loads(capsys.readouterr().out)["tracker"] == "github"


def _decisions(monkeypatch, capsys, now="2026-11-07T12:00:00Z"):
    monkeypatch.setattr(cli.time, "time", lambda: ts(now))
    assert cli.main(["json", "board"]) == 0
    return json.loads(capsys.readouterr().out)["decisions"]


def test_decisions_are_every_prefixed_one_of_the_last_48_hours_open_or_closed(board, monkeypatch, capsys):
    d = _decisions(monkeypatch, capsys)
    assert [(x["task"], x["at"]) for x in d] == [  # newest first; #237's 11-05 09:00 is too old
        ("#306", ts("2026-11-07T09:30:00Z")), ("#292", ts("2026-11-07T08:00:00Z")),
        ("#275", ts("2026-11-06T17:58:43Z")), ("#275", ts("2026-11-06T14:41:53Z")),
        ("#301", ts("2026-11-06T10:00:00Z")), ("#292", ts("2026-11-06T09:00:00Z"))]
    assert d[0]["verdict"] == "ADR 0033 是否采纳 → 采纳，负责人 11-07 拍板。"
    assert [x["task"] for x in d if x["owner"]] == ["#306"]  # no NAWABAN_OWNER_NAMES: only 拍板 says owner
    assert all(x["owner"] is False for x in d[1:])


def test_an_owner_decision_says_拍板_or_names_an_owner_alias(board, monkeypatch, capsys):
    monkeypatch.setenv("NAWABAN_OWNER_NAMES", "owner, 负责人")
    d = _decisions(monkeypatch, capsys)
    assert [x["task"] for x in d if x["owner"]] == ["#306", "#292"]  # 拍板; （owner 2026-11-07…）
    assert all(x["owner"] is False for x in d if x["task"] in ("#275", "#301"))


def test_a_decision_that_waits_for_拍板_is_not_the_owners(board, monkeypatch, capsys):
    issue = {"number": 331, "title": "示例", "state": "OPEN", "stateReason": None, "labels": [], "body": "",
             "createdAt": "2026-11-07T08:00:00Z", "updatedAt": "2026-11-07T10:00:00Z", "closedAt": None,
             "comments": [{"author": {"login": "owner"}, "createdAt": "2026-11-07T10:00:00Z",
                           "body": "决定：学生词 → 默认先拦，理由：和 #274 冲突，等负责人拍板（PR #332）。"}]}
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [issue])
    monkeypatch.setenv("NAWABAN_OWNER_NAMES", "负责人")
    assert [x["owner"] for x in _decisions(monkeypatch, capsys)] == [False]


@pytest.mark.parametrize("body", ["原待定项由负责人拍板为 A", "期待值按 A（负责人拍板）", "A 等同于 B 负责人拍板",
                                  "等了两天负责人拍板选 A", "负责人拍板：等 CI 绿再合", "等 CI 绿后再合，负责人拍板"])
def test_等_or_待_elsewhere_does_not_hide_a_拍板(board, monkeypatch, capsys, body):
    issue = {"number": 1, "title": "示例", "state": "OPEN", "stateReason": None, "labels": [], "body": "",
             "createdAt": "2026-11-07T08:00:00Z", "updatedAt": "2026-11-07T10:00:00Z", "closedAt": None,
             "comments": [{"author": {"login": "owner"}, "createdAt": "2026-11-07T10:00:00Z", "body": "决定：" + body}]}
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [issue])
    assert [x["owner"] for x in _decisions(monkeypatch, capsys)] == [True]


def test_a_repository_the_active_gh_account_cannot_see_is_read_with_another_logged_in_account(monkeypatch):
    # several sessions share one gh: whichever switched last is active, and it may not see this repository
    hosts = {"hosts": {"github.com": [{"login": "me", "active": True}, {"login": "work", "active": False}]}}

    def run(args, **kw):
        token = (kw.get("env") or {}).get("GH_TOKEN")
        if args[1:3] == ["auth", "status"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(hosts), "")
        if args[1:3] == ["auth", "token"]:
            return subprocess.CompletedProcess(args, 0, f"tok-{args[-1]}\n", "")
        if token == "tok-work":
            return subprocess.CompletedProcess(args, 0, '[{"number": 1}]', "")
        return subprocess.CompletedProcess(args, 1, "", "GraphQL: Could not resolve to a Repository with the name 'o/r'.")
    monkeypatch.setattr(cli.subprocess, "run", run)
    assert cli._gh_issues(Path(".")) == [{"number": 1}, {"number": 1}]


# ── objectives and pending decisions (spec NAWABAN-PENDING) ──

def _issue(n, body="", comments=(), parent=None, title="示例", created="2026-11-07T00:00:00Z", state="OPEN"):
    return {"number": n, "url": f"https://github.com/example/roubao/issues/{n}", "title": title, "state": state,
            "stateReason": None, "labels": [], "body": body, "createdAt": created, "updatedAt": created,
            "closedAt": "2026-11-07T00:00:00Z" if state == "CLOSED" else None,
            "parent": {"number": parent} if parent else None,
            "comments": [{"author": {"login": "owner"}, "createdAt": at, "body": b} for at, b in comments]}


def _board(monkeypatch, capsys, issues, now="2026-11-07T12:00:00Z", more=()):
    """json board over issues; more are those gh issue view finds (closed, older than the window)."""
    monkeypatch.setattr(cli, "_gh_issues", lambda root: issues)
    asked = []
    monkeypatch.setattr(cli, "_gh_issue", lambda root, n: asked.append(n) or {i["number"]: i for i in more}.get(n))
    monkeypatch.setattr(cli.time, "time", lambda: ts(now))
    assert cli.main(["json", "board"]) == 0
    out = json.loads(capsys.readouterr().out)
    out["tasks"] = {t["id"]: t for c in out["columns"] for t in c["tasks"]}
    out["asked"] = asked
    return out


OBJ = "意图：排期 1.1 第 3 条，留住新用户\n度量：次日留存，目标 40%，现值 31%（11-06）\n\n细节。"


def test_an_objective_opens_with_an_intent_line_and_a_metric_line(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, OBJ, title="留存"), _issue(2, "度量：x\n意图：y"),
                                       _issue(3, "## 意图：a\n**度量**：b")])
    assert [(o["id"], o["title"], o["intent"], o["metric"], o["url"]) for o in out["objectives"]] == [
        ("#1", "留存", "排期 1.1 第 3 条，留住新用户", "次日留存，目标 40%，现值 31%（11-06）",
         "https://github.com/example/roubao/issues/1"),
        ("#3", "示例", "a", "b", "https://github.com/example/roubao/issues/3")]


def test_a_task_belongs_to_the_first_objective_up_its_parent_chain(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, OBJ), _issue(2, "属于 #1"), _issue(3, parent=2), _issue(4, "x"),
                                       _issue(5, "Parent: #9")],
                 more=[_issue(9, "属于 #8", state="CLOSED"), _issue(8, OBJ, state="CLOSED")])
    assert {i: t["objective"] for i, t in out["tasks"].items()} == {
        "#1": "#1", "#2": "#1", "#3": "#1", "#4": None, "#5": "#8"}
    assert out["asked"] == [9, 8]  # a parent outside the window is fetched once
    assert [o["id"] for o in out["objectives"]] == ["#1", "#8"]


def test_a_native_parent_comes_before_属于(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, OBJ), _issue(2, OBJ), _issue(3, "属于 #2", parent=1)])
    assert (out["tasks"]["#3"]["parent"], out["tasks"]["#3"]["objective"]) == ("#1", "#1")


def test_a_parent_chain_that_loops_ends_with_no_objective(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, "属于 #2"), _issue(2, parent=3), _issue(3, "属于 #1")])
    assert [t["objective"] for t in out["tasks"].values()] == [None] * 3


BRIEF = "进展：测完了。\n\n**待决**：上线 A 还是 B\n【推荐】A\n【默认动作】11-07 08:00 按推荐执行\n【选项】A / B"


def test_a_pending_decision_is_a_待决_line_anywhere_in_a_comment(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", BRIEF)])])
    assert out["tasks"]["#1"]["pending"] == {
        "brief": BRIEF, "at": ts("2026-11-07T01:00:00Z"), "default_action": "11-07 08:00 按推荐执行", "due": True}


def test_a_pending_decision_in_the_body_is_raised_when_the_issue_was(board, monkeypatch, capsys):
    body = "背景。\n需要你定：要不要拆\n【默认动作】可以搁置"
    out = _board(monkeypatch, capsys, [_issue(1, body, created="2026-11-06T00:00:00Z")])
    assert out["tasks"]["#1"]["pending"] == {
        "brief": body, "at": ts("2026-11-06T00:00:00Z"), "default_action": "可以搁置", "due": False}


def test_already_resolved_ends_a_pending_decision_and_决定_does_not(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [
        _issue(1, "待决：x", comments=[("2026-11-07T02:00:00Z", "进展：好。\n已决：选 A")]),
        _issue(2, "待决：x", comments=[("2026-11-07T02:00:00Z", "决定：选 A")]),
        _issue(3, comments=[("2026-11-07T01:00:00Z", "已决：旧的"), ("2026-11-07T02:00:00Z", "待决：新的")])])
    assert [t["pending"] is None for t in out["tasks"].values()] == [True, False, False]
    assert out["tasks"]["#2"]["pending"]["default_action"] is None


@pytest.mark.parametrize("hours,due", [(7.9, False), (8, True)])
def test_carrying_out_the_recommendation_falls_due_8_hours_after_it_was_raised(board, monkeypatch, capsys, hours, due):
    raised = ts("2026-11-07T01:00:00Z")
    now = cli._dt.datetime.fromtimestamp(raised + hours * 3600, cli._dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", BRIEF)])], now=now)
    assert out["tasks"]["#1"]["pending"]["due"] is due


def test_an_objective_lists_the_first_lines_of_its_last_24_hours(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [
        _issue(1, OBJ, comments=[("2026-11-07T11:00:00Z", "进展：留存到 33%。\n细节")]),
        _issue(2, "属于 #1", comments=[("2026-11-06T11:59:59Z", "决定：太早"), ("2026-11-06T12:00:00Z", "## 决定：刚好"),
                                      ("2026-11-07T03:00:00Z", "认领：gh-2"), ("2026-11-07T04:00:00Z", "已决：选 A\n原话")]),
        _issue(3, comments=[("2026-11-07T05:00:00Z", "进展：无目标")])])
    assert out["objectives"][0]["recent"] == [
        {"task": "#2", "at": ts("2026-11-06T12:00:00Z"), "line": "刚好"},
        {"task": "#2", "at": ts("2026-11-07T04:00:00Z"), "line": "选 A"},
        {"task": "#1", "at": ts("2026-11-07T11:00:00Z"), "line": "留存到 33%。"}]
