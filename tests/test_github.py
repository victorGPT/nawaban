"""`json board` in a repository whose tracker is GitHub issues (spec NAWABAN-INDEX, Data mapping)."""

import json
import subprocess
from pathlib import Path
from unittest.mock import ANY

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


def test_on_github_needs_info_waits_on_nobody_a_pending_decision_takes_its_place(board):
    tasks = board()
    assert [t["id"] for t in tasks.values() if t.get("waiting") is not None] == []  # #307, #239 carry needs-info


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


# ── pending decisions (spec NAWABAN-PENDING) ──

def _issue(n, body="", comments=(), parent=None, title="示例", created="2026-11-07T00:00:00Z", state="OPEN"):
    return {"number": n, "url": f"https://github.com/example/roubao/issues/{n}", "title": title, "state": state,
            "stateReason": None, "labels": [], "body": body, "createdAt": created, "updatedAt": created,
            "closedAt": "2026-11-07T00:00:00Z" if state == "CLOSED" else None,
            "parent": {"number": parent} if parent else None,
            "comments": [{"author": {"login": "owner"}, "createdAt": at, "body": b} for at, b in comments]}


def _board(monkeypatch, capsys, issues, now="2026-11-07T12:00:00Z"):
    monkeypatch.setattr(cli, "_gh_issues", lambda root: issues)
    monkeypatch.setattr(cli.time, "time", lambda: ts(now))
    assert cli.main(["json", "board"]) == 0
    out = json.loads(capsys.readouterr().out)
    out["tasks"] = {t["id"]: t for c in out["columns"] for t in c["tasks"]}
    return out


def test_a_native_parent_comes_before_属于(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1), _issue(2), _issue(3, "属于 #2", parent=1)])
    assert out["tasks"]["#3"]["parent"] == "#1"


BRIEF = "进展：测完了。\n\n**待决**：上线 A 还是 B\n【推荐】A\n【选项】A / B"


def test_a_pending_decision_is_a_待决_line_anywhere_in_a_comment(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", BRIEF)])])
    assert out["tasks"]["#1"]["pending"] == {
        "brief": "**待决**：上线 A 还是 B\n【推荐】A\n【选项】A / B", "at": ts("2026-11-07T01:00:00Z"),
        "progress": [{"body": "测完了。", "at": ts("2026-11-07T01:00:00Z")}],  # what comes before the 待决 line is a 进展
        "card": None, "talk": None, "ruled_after": False, "ask": ANY}


def test_a_pending_decision_in_the_body_is_raised_when_the_issue_was(board, monkeypatch, capsys):
    body = "背景。\n需要你定：要不要拆"
    out = _board(monkeypatch, capsys, [_issue(1, body, created="2026-11-06T00:00:00Z")])
    assert out["tasks"]["#1"]["pending"] == {"brief": "需要你定：要不要拆", "at": ts("2026-11-06T00:00:00Z"), "progress": [],
                                             "card": None, "talk": None, "ruled_after": False, "ask": ANY}


def test_already_resolved_ends_a_pending_decision_and_决定_does_not(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [
        _issue(1, "待决：x", comments=[("2026-11-07T02:00:00Z", "进展：好。\n已决：选 A")]),
        _issue(2, "待决：x", comments=[("2026-11-07T02:00:00Z", "决定：选 A")]),
        _issue(3, comments=[("2026-11-07T01:00:00Z", "已决：旧的"), ("2026-11-07T02:00:00Z", "待决：新的")])])
    assert [t["pending"] is None for t in out["tasks"].values()] == [True, False, False]


def test_a_closed_issue_holds_no_pending_decision(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, "待决：x", state="CLOSED")])
    assert "pending" not in out["tasks"]["#1"]


def test_a_pending_decision_carries_its_issues_last_three_进展_oldest_first(board, monkeypatch, capsys):
    notes = [(f"2026-11-0{d}T00:00:00Z", f"进展：第 {d} 步") for d in range(1, 6)]
    out = _board(monkeypatch, capsys, [_issue(1, "待决：x", comments=notes)])
    assert out["tasks"]["#1"]["pending"]["progress"] == [
        {"body": f"第 {d} 步", "at": ts(f"2026-11-0{d}T00:00:00Z")} for d in (3, 4, 5)]


def test_a_进展_posted_the_same_second_as_the_pending_decision_still_counts(board, monkeypatch, capsys):
    s = "2026-11-07T01:00:00Z"
    out = _board(monkeypatch, capsys, [_issue(1, comments=[(s, "进展：独立验收通过"), (s, "进展：准备上线\n待决：选 A 还是 B")])])
    assert [n["body"] for n in out["tasks"]["#1"]["pending"]["progress"]] == ["独立验收通过", "准备上线"]


CARD = "\n".join(["待决：【Decision】sourcemap 传不传", "【Objective / KR】无", "【Context】前端只有压缩堆栈",
                  "【Options】", "- A：传｜可撤回", "- B：不传｜省事", "【Recommendation】A：好查"])


ZH_DR = "\n".join(["待决：决策事项：sourcemap 传不传", "关联 KR：无", "背景：前端只有压缩堆栈", "KR: 背景里的一行",
                   "备选方案：", "- A：传｜可撤回｜双向门", "- B：不传｜省事｜单向门", "建议：A：好查"])


def test_a_decision_request_in_chinese_fields_comes_apart_and_keeps_an_english_looking_line_in_its_context(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", ZH_DR)])])
    assert out["tasks"]["#1"]["pending"]["card"] == {
        "decision": "sourcemap 传不传", "kr": "无", "context": "前端只有压缩堆栈\nKR: 背景里的一行", "rec": "A：好查",
        "options": [{"key": "A", "text": "传", "note": "可撤回｜双向门"}, {"key": "B", "text": "不传", "note": "省事｜单向门"}]}


@pytest.mark.parametrize("brief", [ZH_DR.replace("背景：前端只有压缩堆栈\nKR: 背景里的一行\n", "背景：无\n"), ZH_DR.replace("- B：不传｜省事｜单向门", "- B：不传")])
def test_a_decision_request_in_chinese_fields_missing_its_ready_parts_is_not_ready(board, monkeypatch, capsys, brief):
    assert _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])["tasks"]["#1"]["pending"]["card"] is None


DR = "\n".join(["待决：BLUF: sourcemap 传不传", "KR: 无", "Context: 前端只有压缩堆栈",
                "Options:", "- A：传｜可撤回｜two-way door", "- B：不传｜省事｜one-way door", "Recommendation: A：好查"])


@pytest.mark.parametrize("heading", ["待决：", "## 待决：", "**待决**：", "需要你定："])
def test_a_decision_request_in_english_fields_comes_apart_like_the_old_card(board, monkeypatch, capsys, heading):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", DR.replace("待决：", heading, 1))])])
    assert out["tasks"]["#1"]["pending"]["card"] == {
        "decision": "sourcemap 传不传", "kr": "无", "context": "前端只有压缩堆栈", "rec": "A：好查",
        "options": [{"key": "A", "text": "传", "note": "可撤回｜two-way door"}, {"key": "B", "text": "不传", "note": "省事｜one-way door"}]}


@pytest.mark.parametrize("brief", [DR.replace("Context: 前端只有压缩堆栈\n", ""), DR.replace("BLUF: sourcemap 传不传", "BLUF: 无"),
                                   DR.replace("- B：不传｜省事｜one-way door", "- B：不传"), DR.replace("Recommendation: A：好查", "Recommendation: -")])
def test_a_decision_request_missing_a_dor_field_is_not_ready(board, monkeypatch, capsys, brief):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])
    assert out["tasks"]["#1"]["pending"]["card"] is None


def test_an_old_card_keeps_a_context_line_that_looks_like_a_new_field_in_its_context(board, monkeypatch, capsys):
    brief = CARD.replace("【Context】前端只有压缩堆栈", "【Context】前端只有压缩堆栈\nKR: 无")
    card = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])["tasks"]["#1"]["pending"]["card"]
    assert card["kr"] == "无" and card["context"] == "前端只有压缩堆栈\nKR: 无"


def test_a_full_decision_card_comes_apart_into_its_fields_and_lettered_options(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", CARD)])])
    assert out["tasks"]["#1"]["pending"]["card"] == {
        "decision": "sourcemap 传不传", "kr": "无", "context": "前端只有压缩堆栈", "rec": "A：好查",
        "options": [{"key": "A", "text": "传", "note": "可撤回"}, {"key": "B", "text": "不传", "note": "省事"}]}


@pytest.mark.parametrize("brief", [CARD.replace("【Context】前端只有压缩堆栈\n", ""), CARD.replace("\n- B：不传｜省事", ""),
                                   "待决：定 A 还是 B\n【推荐】A",
                                   CARD.replace("【Decision】sourcemap 传不传", "【Decision】"),
                                   CARD.replace("【Objective / KR】无", "【Objective / KR】 "),
                                   CARD.replace("【Recommendation】A：好查", "【Recommendation】"),
                                   CARD.replace("- B：不传｜省事", "- B：不传"), CARD.replace("- B：不传｜省事", "- B：不传｜ "),
                                   CARD.replace("- B：不传｜省事", "- B：｜省事"),
                                   CARD.replace("【Decision】sourcemap 传不传", "【Decision】无"),
                                   CARD.replace("【Context】前端只有压缩堆栈", "【Context】 None "),
                                   CARD.replace("【Recommendation】A：好查", "【Recommendation】-")])
def test_a_card_missing_a_field_or_a_second_option_is_no_card(board, monkeypatch, capsys, brief):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])
    assert out["tasks"]["#1"]["pending"]["card"] is None


@pytest.mark.parametrize("heading", ["## 待决：", "待决（agent）：", "**待决**：", "需要你定："])
def test_a_card_under_any_pending_heading_is_read(board, monkeypatch, capsys, heading):
    brief = CARD.replace("待决：", heading, 1)
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])
    assert out["tasks"]["#1"]["pending"]["card"]["decision"] == "sourcemap 传不传"


def test_a_field_running_over_several_lines_keeps_every_line(board, monkeypatch, capsys):
    brief = CARD.replace("【Context】前端只有压缩堆栈", "【Context】前端只有压缩堆栈\n线上报错查不到源码行")
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])
    assert out["tasks"]["#1"]["pending"]["card"]["context"] == "前端只有压缩堆栈\n线上报错查不到源码行"


def test_unlettered_options_are_named_by_their_place(board, monkeypatch, capsys):
    brief = CARD.replace("- A：传", "- 传").replace("- B：不传", "- 不传")
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])
    assert [o["key"] for o in out["tasks"]["#1"]["pending"]["card"]["options"]] == ["第 1 项", "第 2 项"]


@pytest.mark.parametrize("option, talk", [("- B：先去 t1d2 窗口盘问", {"window": "t1d2"}),
                                          ("- B：细节到窗口盘问", {"window": None}), ("- B：不传", None)])
def test_a_card_that_sends_you_to_a_window_is_a_talk(board, monkeypatch, capsys, option, talk):
    brief = CARD.replace("- B：不传｜省事", option)
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", brief)])])
    assert out["tasks"]["#1"]["pending"]["talk"] == talk


@pytest.mark.parametrize("later, ruled", [("进展：拆法吴献忠在窗口回「行」", True), ("进展：吴献忠 11-21 拍板", True),
                                          ("进展：吴献忠说先不急", True), ("进展：等吴献忠拍板", False), ("进展：测完了", False)])
def test_a_later_进展_saying_the_owner_ruled_marks_the_card_maybe_decided(board, monkeypatch, capsys, later, ruled):
    monkeypatch.setenv("NAWABAN_OWNER_NAMES", "吴献忠")
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T01:00:00Z", CARD), ("2026-11-07T02:00:00Z", later)])])
    assert out["tasks"]["#1"]["pending"]["ruled_after"] is ruled


def test_only_a_进展_after_the_card_counts_as_the_owner_ruling(board, monkeypatch, capsys):
    out = _board(monkeypatch, capsys, [_issue(1, comments=[("2026-11-07T00:00:00Z", "进展：已拍板旧事"), ("2026-11-07T01:00:00Z", CARD)])])
    assert out["tasks"]["#1"]["pending"]["ruled_after"] is False
