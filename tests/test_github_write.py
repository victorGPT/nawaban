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
    issue = {"state": "OPEN", "body": "", "createdAt": "2026-11-15T00:00:00Z", "comments": [], "assignees": []}
    labels = {"role": "orchestrator"}  # what `hc get` reports for t9
    terminals = []  # what `hc ls` lists
    real_run = subprocess.run

    def run(args, **kw):
        if args[0] == "hc":
            calls.append(args)
            out = {"run": {"address": "t77"}, "ls": {"terminals": terminals}}.get(args[1], {"labels": labels})
            return subprocess.CompletedProcess(args, 0, json.dumps(out), "")
        if args[0] != "gh":
            return real_run(args, **kw)
        calls.append(args[1:])
        if args[1:3] == ["issue", "comment"]:  # what was posted becomes a comment
            issue["comments"].append({"body": args[args.index("--body") + 1], "createdAt": "2026-11-15T01:00:00Z"})
        if args[1:3] == ["issue", "edit"]:
            issue["assignees"] = [{"login": "me"}] if "--add-assignee" in args else []
        out = json.dumps(issue) if args[1:3] == ["issue", "view"] else ""
        return subprocess.CompletedProcess(args, 0, out, "")
    monkeypatch.setattr(subprocess, "run", run)

    def nawaban(*argv):
        code = cli.main(list(argv))
        out = capsys.readouterr()
        return code, out.out + out.err
    calls.issue, calls.nawaban, calls.labels, calls.repo, calls.terminals = issue, nawaban, labels, repo, terminals
    return calls


CARD = ["--kr", "L2 前 5 相关率 ≥70%", "--context", "第 5 轮 84.3%", "--option", "A 接受｜two-way", "--option", "B 重判｜one-way", "--rec", "A"]


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
        assert gh.nawaban("event", "#950", "--kind", kind, "--body", "x", *(CARD if kind == "ask" else []))[0] == 0
        assert posted(gh)[-1].startswith(f"{word}：")


def test_a_decision_by_user_carries_by_user_in_its_marker(gh):
    assert gh.nawaban("event", "#950", "--kind", "decision", "--body", "发布", "--by", "user")[0] == 0
    assert gh.nawaban("event", "#950", "--kind", "decision", "--body", "先不接")[0] == 0
    mine, agents = (cli.read_marker(c) for c in posted(gh))
    assert mine["by"] == "user" and "by" not in agents


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
             "updatedAt": "2026-11-15T01:00:00Z", "labels": [], "body": "", "comments": gh.issue["comments"],
             "assignees": gh.issue["assignees"]}
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
    assert gh.nawaban("event", "#950", "--kind", "ask", "--body", "定 A 还是 B", *CARD)[0] == 0
    code, out = gh.nawaban("event", "#950", "--kind", "ask", "--body", "再定一件", *CARD)
    assert code == 1 and "已有待决" in out
    assert gh.nawaban("event", "#950", "--kind", "resolve", "--body", "A")[0] == 0
    assert gh.nawaban("event", "#950", "--kind", "ask", "--body", "再定一件", *CARD)[0] == 0


def test_only_the_orchestrator_records_a_resolution(gh, monkeypatch):
    gh.labels.clear()  # a worker terminal
    code, out = gh.nawaban("event", "#950", "--kind", "resolve", "--body", "A")
    assert code == 1 and "编排者" in out and posted(gh) == []
    monkeypatch.delenv("HC_TERMINAL_ID")  # a Claude session outside Herdr: no label to show
    assert gh.nawaban("event", "#950", "--kind", "resolve", "--body", "A")[0] == 1
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")  # a person at a shell
    assert gh.nawaban("event", "#950", "--kind", "resolve", "--body", "A")[0] == 0


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
             "updatedAt": "2026-11-15T01:00:00Z", "labels": [], "body": "", "comments": gh.issue["comments"],
             "assignees": gh.issue["assignees"]}
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [issue])
    [task] = [t for c in json.loads(gh.nawaban("json", "board")[1])["columns"] for t in c["tasks"]]
    assert task["status"] == "in_progress"


def _with_origin(repo):
    origin = repo.parent / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    g = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run([*g, "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    subprocess.run([*g, "remote", "add", "origin", str(origin)], check=True)
    subprocess.run([*g, "push", "-q", "origin", "HEAD:main"], check=True)


def test_dispatch_starts_a_worker_in_a_fresh_worktree_and_records_it_on_the_ticket(gh):
    _with_origin(gh.repo)
    code, out = gh.nawaban("dispatch", "#950", "--brief", "目标：修 X", "--accept", "pytest 绿")
    assert code == 0 and "hc t77" in out
    wt = gh.repo.parent / "roubao-w-950"
    assert (wt / ".git").exists()
    run = next(c for c in gh if c[:2] == ["hc", "run"])
    assert run[run.index("--cwd") + 1] == str(wt)
    brief = run[-1]
    assert brief.startswith("/pstack:poteto-mode Issue：#950") and "目标：修 X" in brief and "验收：pytest 绿" in brief
    assert 'hc send t9 "回报：#950 完成 |' in brief
    assert "中途进展、阶段结果记在票上" in brief  # 只报完成、受阻：每条回报都叫醒编排者
    note = cli.read_marker(posted(gh)[0])
    assert note["kind"] == "note" and "hc t77" in note["body"] and "验收：pytest 绿" in note["body"]


def test_dispatch_without_a_live_orchestrator_starts_nothing(gh):
    gh.labels.clear()
    code, out = gh.nawaban("dispatch", "#950", "--brief", "b", "--accept", "a")
    assert code == 1 and "编排者" in out and not any(c[:2] == ["hc", "run"] for c in gh)


def test_dispatch_from_outside_herdr_reports_to_the_repositorys_orchestrator(gh, monkeypatch):
    _with_origin(gh.repo)
    monkeypatch.delenv("HC_TERMINAL_ID")
    nested = gh.repo / "vendor" / "lib"
    subprocess.run(["git", "init", "-q", str(nested)], check=True)
    gh.terminals += [{"address": "t4", "state": "live", "cwd": str(nested)},  # a repository of its own
                     {"address": "t5", "state": "live", "cwd": str(gh.repo)}]
    code, out = gh.nawaban("dispatch", "--name", "nightly-1116", "--brief", "复盘", "--accept", "照 nightly-review.md")
    assert code == 0 and posted(gh) == []
    assert 'hc send t5 "回报：nightly-1116 完成' in next(c for c in gh if c[:2] == ["hc", "run"])[-1]


def test_dispatch_names_the_running_worker_when_the_ticket_note_fails(gh, monkeypatch):
    _with_origin(gh.repo)
    real = cli._gh
    monkeypatch.setattr(cli, "_gh", lambda root, *a: (_ for _ in ()).throw(cli.Refused("HTTP 503")) if a[:2] == ("issue", "comment") else real(root, *a))
    code, out = gh.nawaban("dispatch", "#950", "--brief", "b", "--accept", "a")
    assert code == 1 and "已派给 hc t77" in out and "补记:nawaban event '#950' --kind note" in out


def test_dispatch_to_a_closed_issue_starts_nothing(gh):
    gh.issue["state"] = "CLOSED"
    assert gh.nawaban("dispatch", "#950", "--brief", "b", "--accept", "a")[0] == 1
    assert not any(c[:2] == ["hc", "run"] for c in gh)


def test_dispatch_on_a_local_board_records_a_dispatch_note(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "proj"
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
    _with_origin(repo)
    db = str(tmp_path / "b.db")
    cli.main(["--db", db, "init"]); cli.main(["--db", db, "create", "P-01", "--title", "t", "--body", ""])
    monkeypatch.chdir(repo)
    monkeypatch.setenv("HC_TERMINAL_ID", "t9")
    real_run, runs = subprocess.run, []

    def run(args, **kw):
        if args[0] != "hc":
            return real_run(args, **kw)
        runs.append(args)
        return subprocess.CompletedProcess(args, 0, json.dumps({"address": "t77"} if args[1] == "run" else {"labels": {"role": "orchestrator"}}), "")
    monkeypatch.setattr(subprocess, "run", run)
    capsys.readouterr()
    assert cli.main(["--db", db, "dispatch", "P-01", "--brief", "b", "--accept", "a"]) == 0
    assert (tmp_path / "proj-p-01" / ".git").exists()
    assert f"NAWABAN_DB={tmp_path / 'b.db'}" in runs[-1]
    assert runs[-1][-1].startswith("/pstack:poteto-mode 任务：P-01") and 'hc send t9 "回报：P-01 完成' in runs[-1][-1]
    cli.main(["--db", db, "show", "P-01"])
    assert "dispatch: p-01 · 派给 hc t77" in capsys.readouterr().out


@pytest.mark.parametrize("drop", ["--kr", "--context", "--rec"])
def test_a_decision_card_missing_a_field_is_refused_before_posting(gh, drop):
    i = CARD.index(drop)
    code, out = gh.nawaban("event", "#950", "--kind", "ask", "--body", "定 A 还是 B", *CARD[:i], *CARD[i + 2:])
    assert code == 1 and drop in out and posted(gh) == []


def test_a_decision_card_needs_two_options(gh):
    one = CARD[:6] + CARD[8:]  # only option A
    code, out = gh.nawaban("event", "#950", "--kind", "ask", "--body", "定 A 还是 B", *one)
    assert code == 1 and "--option" in out and posted(gh) == []


@pytest.mark.parametrize("flag, value, named", [("--option", "B 重判", "第 2 项 的 trade-off"),
                                               ("--option", "｜one-way", "的选项"), ("--context", "无", "Context"),
                                               ("--rec", " - ", "Recommendation"), ("--kr", " ", "Objective / KR")])
def test_a_decision_card_with_an_empty_part_is_refused_naming_it(gh, flag, value, named):
    card = list(CARD)
    card[len(card) - 1 - card[::-1].index(flag) + 1] = value
    code, out = gh.nawaban("event", "#950", "--kind", "ask", "--body", "定 A 还是 B", *card)
    assert code == 1 and named in out and posted(gh) == []


def test_a_decision_card_whose_decision_says_nothing_is_refused(gh):
    code, out = gh.nawaban("event", "#950", "--kind", "ask", "--body", "无", *CARD)
    assert code == 1 and "Decision" in out and posted(gh) == []


def test_ask_posts_the_card_in_order_and_marks_its_kr(gh):
    assert gh.nawaban("event", "#950", "--kind", "ask", "--body", "定 A 还是 B", *CARD)[0] == 0
    [comment] = posted(gh)
    heads = ["【Decision】定 A 还是 B", "【Objective / KR】L2 前 5 相关率 ≥70%", "【Context】第 5 轮 84.3%",
             "【Options】\n- A 接受｜two-way\n- B 重判｜one-way", "【Recommendation】A"]
    at = [comment.index(h) for h in heads]
    assert at == sorted(at)
    assert cli.read_marker(comment)["kr"] == "L2 前 5 相关率 ≥70%"


def test_a_delegated_decision_carries_its_kr(gh, tmp_path, capsys):
    assert gh.nawaban("event", "#950", "--kind", "decision", "--body", "先修一轮", "--kr", "KR1")[0] == 0
    [comment] = posted(gh)
    assert comment.startswith("决定：[KR1] 先修一轮") and cli.read_marker(comment)["kr"] == "KR1"
    db = str(tmp_path / "b.db")
    cli.main(["--db", db, "init"])
    cli.main(["--db", db, "create", "T", "--title", "t", "--body", ""])
    assert cli.main(["--db", db, "event", "T", "--kind", "decision", "--body", "先修一轮", "--kr", "KR1"]) == 0
    capsys.readouterr()
    cli.main(["--db", db, "show", "T"])
    assert "[KR1] 先修一轮" in capsys.readouterr().out


def test_kr_belongs_only_to_asks_and_decisions(gh):
    code, out = gh.nawaban("event", "#950", "--kind", "note", "--body", "x", "--kr", "KR1")
    assert code == 1 and "--kr" in out and posted(gh) == []
