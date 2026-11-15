"""Writes to a GitHub-tracked repository go through nawaban (spec NAWABAN-PROTO, ticket 01)."""

import json
import subprocess

import pytest

from nawaban import cli


@pytest.fixture
def gh(tmp_path, monkeypatch, capsys):
    """A GitHub-tracked repository with `gh` faked: returns the calls made; `gh.issue` is what `issue view` reads."""
    repo = tmp_path / "roubao"
    (repo / "docs" / "agents").mkdir(parents=True)
    (repo / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(repo)
    monkeypatch.setenv("HC_TERMINAL_ID", "t9")
    calls = type("Calls", (list,), {})()
    issue = {"body": "", "createdAt": "2026-11-15T00:00:00Z", "comments": []}
    real_run = subprocess.run

    def run(args, **kw):
        if args[0] != "gh":
            return real_run(args, **kw)
        calls.append(args[1:])
        if args[1:3] == ["issue", "comment"]:  # what was posted becomes a comment
            issue["comments"].append({"body": args[args.index("--body") + 1], "createdAt": "2026-11-15T01:00:00Z"})
        out = json.dumps(issue) if args[1:3] == ["issue", "view"] else ""
        return subprocess.CompletedProcess(args, 0, out, "")
    monkeypatch.setattr(subprocess, "run", run)

    def nawaban(*argv):
        code = cli.main(list(argv))
        out = capsys.readouterr()
        return code, out.out + out.err
    calls.issue, calls.nawaban = issue, nawaban
    return calls


def posted(calls):
    return [c[c.index("--body") + 1] for c in calls if c[:2] == ["issue", "comment"]]


@pytest.mark.parametrize("body", ["一行", "多行\n第二行\r\n第三行", "含 --> 和 <!-- 和 -- 的正文"])
def test_an_event_posts_its_prefix_for_people_and_a_marker_that_reads_back_exactly(gh, body):
    code, out = gh.nawaban("event", "#950", "--kind", "note", "--body", body)
    assert code == 0, out
    [comment] = posted(gh)
    assert comment.startswith(f"进展：{body}")
    ev = cli.read_marker(comment)
    assert ev["kind"] == "note" and ev["body"] == body
    assert ev["author"] == "selftest-session" and ev["terminal"] == "t9" and ev["uid"]


def test_each_kind_keeps_the_prefix_the_old_readers_know(gh):
    for kind, word in [("decision", "决定"), ("link", "PR"), ("ask", "待决"), ("resolve", "已决")]:
        assert gh.nawaban("event", "#950", "--kind", kind, "--body", "x")[0] == 0
        assert posted(gh)[-1].startswith(f"{word}：x")


def test_claim_assigns_the_issue_and_posts_a_claim_naming_the_terminal(gh):
    code, out = gh.nawaban("claim", "#950")
    assert code == 0, out
    assert ["issue", "edit", "950", "--add-assignee", "@me"] in gh
    [comment] = posted(gh)
    assert comment.startswith("认领：selftest-session（hc t9）")
    assert cli.read_marker(comment)["kind"] == "claim"


def test_release_unassigns_and_the_board_shows_the_issue_open_again(gh, monkeypatch):
    assert gh.nawaban("claim", "#950")[0] == 0
    assert gh.nawaban("claim", "#950", "--release")[0] == 0
    assert ["issue", "edit", "950", "--remove-assignee", "@me"] in gh
    assert posted(gh)[-1].startswith("交还：selftest-session")
    issue = {"number": 950, "title": "t", "state": "OPEN", "createdAt": "2026-11-15T00:00:00Z",
             "updatedAt": "2026-11-15T01:00:00Z", "labels": [], "body": "", "comments": gh.issue["comments"]}
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [issue])
    code, out = gh.nawaban("json", "board")
    [task] = [t for c in json.loads(out)["columns"] for t in c["tasks"]]
    assert task["status"] == "open" and task["session"] is None


@pytest.mark.parametrize("flag,cmd", [("--done", ["issue", "close", "950", "--reason", "completed"]),
                                      ("--cancelled", ["issue", "close", "950", "--reason", "not planned"]),
                                      ("--reopen", ["issue", "reopen", "950"])])
def test_close_sets_the_issue_state(gh, flag, cmd):
    assert gh.nawaban("close", "#950", flag)[0] == 0
    assert cmd in gh


def test_a_second_pending_decision_on_one_issue_is_refused_until_resolved(gh):
    assert gh.nawaban("event", "#950", "--kind", "ask", "--body", "定 A 还是 B")[0] == 0
    code, out = gh.nawaban("event", "#950", "--kind", "ask", "--body", "再定一件")
    assert code == 1 and "已有待决" in out
    assert gh.nawaban("event", "#950", "--kind", "resolve", "--body", "A")[0] == 0
    assert gh.nawaban("event", "#950", "--kind", "ask", "--body", "再定一件")[0] == 0


def test_ask_and_resolve_are_refused_on_a_local_board(tmp_path, capsys):
    db = str(tmp_path / "b.db")
    cli.main(["--db", db, "init"])
    cli.main(["--db", db, "create", "T", "--title", "t", "--body", ""])
    capsys.readouterr()
    assert cli.main(["--db", db, "event", "T", "--kind", "ask", "--body", "x"]) == 1
    assert "GitHub" in capsys.readouterr().err


def test_a_body_quoting_a_marker_still_reads_back_its_own_event(gh):
    body = "示例：<!-- nawaban {} --> 和 <!-- nawaban {bad} -->\n结尾"
    assert gh.nawaban("event", "#950", "--kind", "note", "--body", body)[0] == 0
    assert cli.read_marker(posted(gh)[0])["body"] == body
    assert cli.read_marker("进展：x\n<!-- nawaban {bad} -->") is None


def test_claim_without_identity_writes_nothing_remote(gh, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    monkeypatch.delenv("NAWABAN_OWNER")
    code, out = gh.nawaban("claim", "#950")
    assert code == 1 and "身份缺失" in out
    assert gh == []


def test_a_claim_after_a_release_in_the_same_second_holds(gh, monkeypatch):
    for argv in (["claim", "#950"], ["claim", "#950", "--release"], ["claim", "#950"]):
        assert gh.nawaban(*argv)[0] == 0
    issue = {"number": 950, "title": "t", "state": "OPEN", "createdAt": "2026-11-15T00:00:00Z",
             "updatedAt": "2026-11-15T01:00:00Z", "labels": [], "body": "", "comments": gh.issue["comments"]}
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [issue])
    [task] = [t for c in json.loads(gh.nawaban("json", "board")[1])["columns"] for t in c["tasks"]]
    assert task["status"] == "in_progress"
