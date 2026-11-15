"""The GitHub board reads markers first and claims from assignees (spec NAWABAN-PROTO, ticket 02)."""

import json

from nawaban import cli


def board(monkeypatch, capsys, issues, now="2026-11-15T12:00:00Z"):
    import subprocess
    repo = cli.Path.cwd() / "roubao"
    (repo / "docs" / "agents").mkdir(parents=True)
    (repo / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(repo)
    monkeypatch.setattr(cli, "_gh_issues", lambda root: issues)
    monkeypatch.setattr(cli.time, "time", lambda: cli._at(now))
    assert cli.main(["json", "board"]) == 0
    out = json.loads(capsys.readouterr().out)
    return {t["id"]: t for c in out["columns"] for t in c["tasks"]}, out["decisions"]


def issue(comments, assignees=(), n=1):
    return {"number": n, "title": "t", "state": "OPEN", "createdAt": "2026-11-15T00:00:00Z",
            "updatedAt": "2026-11-15T00:00:00Z", "labels": [], "body": "",
            "assignees": [{"login": a} for a in assignees],
            "comments": [{"createdAt": f"2026-11-15T0{k + 1}:00:00Z", "body": b} for k, b in enumerate(comments)]}


def marked(kind, body, visible="（人改过的可见文字）", **extra):
    return visible + "\n\n" + cli.marker({"v": 1, "uid": "u", "kind": kind, "author": "s1", "at": 0, "body": body} | extra)


def test_an_assignee_alone_is_a_claim_named_by_its_login(monkeypatch, capsys):
    tasks, _ = board(monkeypatch, capsys, [issue([], assignees=["yuebutong"])])
    assert tasks["#1"]["status"] == "in_progress" and tasks["#1"]["session"] == "yuebutong"


def test_a_claim_comment_without_an_assignee_is_not_held(monkeypatch, capsys):
    tasks, _ = board(monkeypatch, capsys, [issue(["认领：s1（hc t2）"])])
    assert tasks["#1"]["status"] == "open"


def test_the_marker_wins_over_edited_visible_text(monkeypatch, capsys):
    tasks, _ = board(monkeypatch, capsys, [issue([marked("claim", "s1（hc t7）"), marked("note", "真实进展")],
                                                  assignees=["wuxianzhong-gpt"])])
    t = tasks["#1"]
    assert t["session"] == "s1（hc t7）" and t["terminal"] == "t7" and t["progress"]["body"] == "真实进展"


def test_a_marked_ask_is_pending_and_a_marked_resolve_ends_it(monkeypatch, capsys):
    tasks, _ = board(monkeypatch, capsys, [issue([marked("ask", "定 A 还是 B\n【推荐】A")])])
    assert tasks["#1"]["pending"]["brief"] == "待决：定 A 还是 B\n【推荐】A"
    tasks, _ = board(monkeypatch, capsys, [issue([marked("ask", "定 A"), marked("resolve", "A")])])
    assert tasks["#1"]["pending"] is None


def test_a_resolve_is_the_owners_decision(monkeypatch, capsys):
    _, decisions = board(monkeypatch, capsys, [issue([marked("resolve", "选 A"), "决定：agent 自己定的"])])
    assert [(d["verdict"], d["owner"]) for d in decisions] == [("agent 自己定的", False), ("选 A", True)]


def test_a_malformed_marker_falls_back_to_the_visible_text(monkeypatch, capsys):
    bad = ['进展：可见\n<!-- nawaban {"kind": "note"} -->', '进展：可见二\n<!-- nawaban {"kind": "nope", "body": "x"} -->',
           '进展：可见三\n<!-- nawaban {"kind": [], "body": "x"} -->']
    tasks, _ = board(monkeypatch, capsys, [issue(bad)])
    assert tasks["#1"]["progress"]["body"] == "可见三"
