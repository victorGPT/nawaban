"""The new tracker CLI, driven against a temporary board (spec NAWABAN-LEAN, seam 1)."""

import pytest

from nawaban import cli


@pytest.fixture
def run(tmp_path, capsys):
    board = tmp_path / "proj" / ".nawaban" / "board.db"

    def run(*args, db=board):
        code = cli.main(["--db", str(db), *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    assert run("init")[0] == 0
    run.board = board
    return run


def test_init_creates_an_empty_board(run):
    assert run.board.exists()
    assert run("list") == (0, "", "")


def test_init_twice_keeps_existing_tasks(run):
    run("create", "T", "--title", "t", "--body", "b")
    assert run("init")[0] == 0
    assert "T" in run("list")[1]


def test_init_refuses_a_file_that_is_not_a_new_board(run, tmp_path):
    import sqlite3
    old = tmp_path / "old.db"
    sqlite3.connect(old).execute("CREATE TABLE tasks (id TEXT)").connection.close()
    code, _, err = run("init", db=old)
    assert code == 1 and "不是新版看板" in err
    code, _, err = run("list", db=old)
    assert code == 1 and "不是新版看板" in err


def test_missing_board_is_an_error(run, tmp_path):
    code, _, err = run("list", db=tmp_path / "nope.db")
    assert code == 1 and "看板不存在" in err


def test_create_then_show_round_trips_title_and_body(run):
    assert run("create", "T-1", "--title", "能看到任务", "--body", "## What to build\n做点事")[0] == 0
    code, out, _ = run("show", "T-1")
    assert code == 0
    assert "能看到任务" in out and "## What to build\n做点事" in out
    assert "open" in out


def test_create_reads_body_from_file(run, tmp_path):
    f = tmp_path / "body.md"
    f.write_text("# 长正文\n\n## Acceptance criteria\n- 可以\n", encoding="utf-8")
    assert run("create", "T", "--title", "t", "--body-file", str(f))[0] == 0
    assert "## Acceptance criteria\n- 可以" in run("show", "T")[1]


def test_create_needs_exactly_one_body_source(run):
    with pytest.raises(SystemExit) as e:
        run("create", "T", "--title", "t")
    assert e.value.code == 2


def test_project_defaults_to_board_directory(run):
    run("create", "T", "--title", "t", "--body", "b")
    assert "项目 proj" in run("show", "T")[1]


def test_project_defaults_to_the_repository_the_command_runs_in(run, tmp_path, monkeypatch):
    import subprocess
    shared = tmp_path / "shared" / "board.db"
    assert run("init", db=shared)[0] == 0
    repo = tmp_path / "myrepo"
    (repo / "sub").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(repo / "sub")
    run("create", "T", "--title", "t", "--body", "b", db=shared)
    assert "项目 myrepo" in run("show", "T", db=shared)[1]


def test_outside_a_repository_project_comes_from_the_board_not_a_nawaban_dir_above(run, tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".nawaban").mkdir(parents=True)
    (home / "docs").mkdir()
    monkeypatch.chdir(home / "docs")
    run("create", "T", "--title", "t", "--body", "b")
    assert "项目 proj" in run("show", "T")[1]


def test_child_inherits_parent_project(run):
    run("create", "P", "--title", "p", "--body", "b", "--project", "alpha")
    run("create", "C", "--title", "c", "--body", "b", "--parent", "P")
    out = run("show", "C")[1]
    assert "项目 alpha" in out and "父任务 P" in out


def test_explicit_project_beats_parent(run):
    run("create", "P", "--title", "p", "--body", "b", "--project", "alpha")
    run("create", "C", "--title", "c", "--body", "b", "--parent", "P", "--project", "beta")
    assert "项目 beta" in run("show", "C")[1]


def test_create_with_unknown_parent_fails(run):
    code, _, err = run("create", "C", "--title", "c", "--body", "b", "--parent", "NOPE")
    assert code == 1 and "NOPE" in err
    assert run("list")[1] == ""


def test_create_with_unknown_parent_and_explicit_project_says_the_parent_does_not_exist(run):
    code, _, err = run("create", "C", "--title", "c", "--body", "b", "--parent", "NOPE", "--project", "q")
    assert code == 1 and "任务不存在:NOPE" in err and "已存在" not in err
    assert run("list")[1] == ""


def test_create_duplicate_id_fails(run):
    run("create", "T", "--title", "t", "--body", "b")
    code, _, err = run("create", "T", "--title", "again", "--body", "b")
    assert code == 1 and "已存在" in err


def test_create_rejects_an_id_with_whitespace(run):
    code, _, err = run("create", "A B", "--title", "t", "--body", "b")
    assert code == 1 and "id" in err


@pytest.mark.parametrize("kind", ["note", "decision", "link"])
def test_event_of_each_kind_shows_up_with_author(run, kind):
    run("create", "T", "--title", "t", "--body", "b")
    assert run("event", "T", "--kind", kind, "--body", f"{kind} 内容")[0] == 0
    out = run("show", "T")[1]
    assert f"{kind} · selftest-session" in out and f"{kind} 内容" in out


def test_events_show_newest_first_and_latest_note_is_progress(run):
    run("create", "T", "--title", "t", "--body", "b")
    run("event", "T", "--kind", "note", "--body", "第一步")
    run("event", "T", "--kind", "link", "--body", "pr:https://example.com/pull/1")
    run("event", "T", "--kind", "note", "--body", "第二步")
    out = run("show", "T")[1]
    assert "当前进展:第二步" in out
    assert out.index("第二步", out.index("最近事件")) < out.index("第一步")


@pytest.mark.parametrize("outcome", ["--done", "--cancelled"])
def test_a_closed_task_shows_no_current_progress(run, outcome):
    run("create", "T", "--title", "t", "--body", "b")
    run("event", "T", "--kind", "note", "--body", "旧进展")
    run("close", "T", outcome)
    out = run("show", "T")[1]
    assert "当前进展" not in out and "旧进展" in out


def test_an_in_progress_task_shows_its_current_progress(run):
    run("create", "T", "--title", "t", "--body", "b")
    run("claim", "T")
    run("event", "T", "--kind", "note", "--body", "正在做")
    assert "当前进展:正在做" in run("show", "T")[1]


def test_decision_by_user(run):
    run("create", "T", "--title", "t", "--body", "b")
    run("event", "T", "--kind", "decision", "--body", "问:A 还是 B · 定:A · 否:B", "--by", "user")
    assert "decision · user" in run("show", "T")[1]


def test_identity_falls_back_to_nawaban_owner(run, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    run("create", "T", "--title", "t", "--body", "b")
    run("event", "T", "--kind", "note", "--body", "x")
    assert "note · ac:selftest" in run("show", "T")[1]


def test_event_without_identity_fails(run, monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    monkeypatch.delenv("NAWABAN_OWNER")
    run("create", "T", "--title", "t", "--body", "b")
    code, _, err = run("event", "T", "--kind", "note", "--body", "x")
    assert code == 1 and "NAWABAN_OWNER" in err


def test_event_rejects_status_kind(run):
    run("create", "T", "--title", "t", "--body", "b")
    with pytest.raises(SystemExit) as e:
        run("event", "T", "--kind", "status", "--body", "x")
    assert e.value.code == 2


@pytest.mark.parametrize("args", [
    ("show", "NOPE"),
    ("event", "NOPE", "--kind", "note", "--body", "x"),
    ("list", "--parent", "NOPE"),
])
def test_unknown_task_id_fails(run, args):
    code, _, err = run(*args)
    assert code == 1 and "NOPE" in err


def test_list_filters_by_project_and_parent(run):
    run("create", "P", "--title", "父", "--body", "b", "--project", "alpha")
    run("create", "C", "--title", "子", "--body", "b", "--parent", "P")
    run("create", "X", "--title", "别的", "--body", "b", "--project", "beta")
    out = run("list")[1]
    assert all(t in out for t in ("P", "C", "X"))
    alpha = run("list", "--project", "alpha")[1]
    assert "子" in alpha and "父" in alpha and "别的" not in alpha
    kids = run("list", "--parent", "P")[1].splitlines()
    assert len(kids) == 1 and kids[0].startswith("C")
    assert run("list", "--project", "gamma") == (0, "", "")


def test_backup_writes_a_readable_copy(run):
    run("create", "T", "--title", "备份我", "--body", "b")
    code, out, _ = run("backup")
    assert code == 0
    copies = list((run.board.parent / "backups").glob("nawaban-*.db"))
    assert len(copies) == 1 and str(copies[0]) in out
    assert "备份我" in run("show", "T", db=copies[0])[1]


# ── blocked-by edges ──────────────────────────────────────────────

def _tasks(run, *ids):
    for t in ids:
        run("create", t, "--title", f"任务{t}", "--body", "b", "--project", "alpha")


def _ids(out):
    return {line.split()[0] for line in out.splitlines()}


def test_block_shows_blocker_and_dependent(run):
    _tasks(run, "A", "B")
    assert run("block", "B", "A")[0] == 0
    assert "被挡:A open" in run("show", "B")[1]
    assert "下游任务:B open" in run("show", "A")[1]


def test_block_twice_is_a_no_op(run):
    _tasks(run, "A", "B")
    run("block", "B", "A")
    assert run("block", "B", "A")[0] == 0
    assert run("show", "B")[1].count("A open") == 1


@pytest.mark.parametrize("args", [("B", "NOPE"), ("NOPE", "B")])
def test_block_refuses_unknown_ids(run, args):
    _tasks(run, "B")
    code, _, err = run("block", *args)
    assert code == 1 and "NOPE" in err


def test_block_refuses_self_edge(run):
    _tasks(run, "A")
    code, _, err = run("block", "A", "A")
    assert code == 1 and "自己" in err


def test_block_refuses_cycles(run):
    _tasks(run, "A", "B", "C")
    run("block", "B", "A")
    run("block", "C", "B")
    for blocker in ("B", "C"):
        code, _, err = run("block", "A", blocker)
        assert code == 1 and "成环" in err
    assert "被挡" not in run("show", "A")[1]


def test_create_with_blocked_by(run):
    _tasks(run, "A", "B")
    assert run("create", "C", "--title", "c", "--body", "b", "--blocked-by", "A", "--blocked-by", "B")[0] == 0
    out = run("show", "C")[1]
    assert "A open" in out and "B open" in out


def test_create_with_unknown_blocker_creates_nothing(run):
    _tasks(run, "A")
    code, _, err = run("create", "C", "--title", "c", "--body", "b", "--blocked-by", "A", "--blocked-by", "NOPE")
    assert code == 1 and "任务不存在:NOPE" in err
    assert "C" not in _ids(run("list")[1])
    assert "下游任务" not in run("show", "A")[1]


def test_create_refuses_blocking_itself(run):
    code, _, err = run("create", "C", "--title", "c", "--body", "b", "--blocked-by", "C")
    assert code == 1 and "自己" in err
    assert run("list")[1] == ""


# ── claim ─────────────────────────────────────────────────────────

def _status_of(run, task):
    return next(line.split()[1] for line in run("list")[1].splitlines() if line.split()[0] == task)


def test_claim_makes_task_in_progress_in_show_and_list(run):
    _tasks(run, "T")
    code, out, _ = run("claim", "T")
    assert code == 0 and "selftest-session" in out
    shown = run("show", "T")[1]
    assert "状态 in_progress" in shown and "窗口 selftest-session" in shown
    assert "status · selftest-session] open→in_progress" in shown
    assert _status_of(run, "T") == "in_progress"


def test_claim_again_by_holder_is_a_no_op(run):
    _tasks(run, "T")
    run("claim", "T")
    assert run("claim", "T")[0] == 0
    assert run("show", "T")[1].count("open→in_progress") == 1


def test_claim_held_by_another_session_fails_and_names_holder(run, monkeypatch):
    _tasks(run, "T")
    run("claim", "T")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "other-session")
    code, _, err = run("claim", "T")
    assert code == 1 and "selftest-session" in err and "--take" in err
    assert "窗口 selftest-session" in run("show", "T")[1]


def test_take_moves_the_claim_and_records_an_event(run, monkeypatch):
    _tasks(run, "T")
    run("claim", "T")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "other-session")
    assert run("claim", "T", "--take")[0] == 0
    out = run("show", "T")[1]
    assert "窗口 other-session" in out
    assert "status · other-session] in_progress→in_progress · 接手自 selftest-session" in out


def test_release_returns_task_to_frontier(run):
    _tasks(run, "T")
    run("claim", "T")
    assert "T" not in _ids(run("list", "--frontier")[1])
    assert run("claim", "T", "--release")[0] == 0
    out = run("show", "T")[1]
    assert "状态 open" in out and "窗口" not in out and "in_progress→open" in out
    assert _status_of(run, "T") == "open"
    assert "T" in _ids(run("list", "--frontier")[1])


def test_release_of_unheld_task_is_a_no_op(run):
    _tasks(run, "T")
    assert run("claim", "T", "--release")[0] == 0
    assert "status" not in run("show", "T")[1]


def test_release_by_another_session_needs_take(run, monkeypatch):
    _tasks(run, "T")
    run("claim", "T")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "other-session")
    code, _, err = run("claim", "T", "--release")
    assert code == 1 and "selftest-session" in err
    assert run("claim", "T", "--release", "--take")[0] == 0
    assert "窗口" not in run("show", "T")[1]


@pytest.mark.parametrize("args", [("claim", "T"), ("close", "T", "--done")])
def test_claim_and_close_need_identity(run, monkeypatch, args):
    _tasks(run, "T")
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    monkeypatch.delenv("NAWABAN_OWNER")
    code, _, err = run(*args)
    assert code == 1 and "NAWABAN_OWNER" in err


@pytest.mark.parametrize("args", [("claim", "NOPE"), ("close", "NOPE", "--done")])
def test_claim_and_close_unknown_task_fails(run, args):
    code, _, err = run(*args)
    assert code == 1 and "NOPE" in err


# ── close ─────────────────────────────────────────────────────────

def test_close_done_clears_session_and_records_status(run):
    _tasks(run, "T")
    run("claim", "T")
    assert run("close", "T", "--done")[0] == 0
    out = run("show", "T")[1]
    assert "状态 done" in out and "窗口" not in out and "in_progress→done" in out
    assert _status_of(run, "T") == "done"


def test_close_cancelled(run):
    _tasks(run, "T")
    assert run("close", "T", "--cancelled")[0] == 0
    out = run("show", "T")[1]
    assert "状态 cancelled" in out and "open→cancelled" in out


def test_reopen_a_closed_task(run):
    _tasks(run, "T")
    run("close", "T", "--done")
    assert run("close", "T", "--reopen")[0] == 0
    out = run("show", "T")[1]
    assert "状态 open" in out and "done→open" in out
    assert "T" in _ids(run("list", "--frontier")[1])


@pytest.mark.parametrize("outcome", ["--done", "--cancelled"])
def test_claim_of_a_closed_task_is_refused_and_points_to_reopen(run, outcome):
    _tasks(run, "T")
    run("close", "T", outcome)
    code, _, err = run("claim", "T")
    assert code == 1 and "close --reopen" in err
    assert "窗口" not in run("show", "T")[1]
    code, _, err = run("claim", "T", "--take")
    assert code == 1 and "close --reopen" in err


def test_close_to_current_status_is_a_no_op(run):
    _tasks(run, "T")
    run("close", "T", "--done")
    assert run("close", "T", "--done")[0] == 0
    assert run("close", "T", "--cancelled")[0] == 0
    out = run("show", "T")[1]
    assert out.count("→done") == 1 and "done→cancelled" in out


def test_close_needs_exactly_one_outcome(run):
    _tasks(run, "T")
    for args in (("close", "T"), ("close", "T", "--done", "--reopen")):
        with pytest.raises(SystemExit) as e:
            run(*args)
        assert e.value.code == 2


# ── frontier ──────────────────────────────────────────────────────

def test_frontier_lists_only_open_unheld_unblocked_tasks(run):
    _tasks(run, "READY", "HELD", "DONE", "GONE", "WAITS", "FREED", "DEP")
    run("claim", "HELD")
    run("close", "DONE", "--done")
    run("close", "GONE", "--cancelled")
    run("block", "WAITS", "DEP")
    run("block", "FREED", "DONE")
    run("block", "FREED", "GONE")
    assert _ids(run("list", "--frontier")[1]) == {"READY", "FREED", "DEP"}


def test_frontier_unblocks_when_blocker_closes(run):
    _tasks(run, "A", "B")
    run("block", "B", "A")
    assert _ids(run("list", "--frontier")[1]) == {"A"}
    run("close", "A", "--done")
    assert _ids(run("list", "--frontier")[1]) == {"B"}


def test_frontier_composes_with_parent_and_project(run):
    run("create", "SPEC", "--title", "s", "--body", "b", "--project", "alpha")
    run("create", "S1", "--title", "s1", "--body", "b", "--parent", "SPEC")
    run("create", "X", "--title", "x", "--body", "b", "--project", "beta")
    assert _ids(run("list", "--parent", "SPEC", "--frontier")[1]) == {"S1"}
    assert _ids(run("list", "--project", "beta", "--frontier")[1]) == {"X"}


# ── json: the read projections the Herdr panel draws ──────────────

def _json(run, *args, **kw):
    import json
    code, out, _ = run("json", *args, **kw)
    return code, json.loads(out)


def _column(board_json, key):
    return {c["key"]: [t["id"] for t in c["tasks"]] for c in board_json["columns"]}[key]


def test_json_empty_board_has_no_projects_and_empty_columns(run):
    assert _json(run, "projects") == (0, {"projects": []})
    code, data = _json(run, "board")
    assert code == 0
    assert [(c["key"], c["tasks"]) for c in data["columns"]] == [
        ("open", []), ("in_progress", []), ("done", [])]


def test_json_projects_count_open_and_total_tasks(run):
    run("create", "A", "--title", "a", "--body", "", "--project", "alpha")
    run("create", "B", "--title", "b", "--body", "", "--project", "alpha")
    run("create", "C", "--title", "c", "--body", "", "--project", "beta")
    run("close", "B", "--done")
    assert _json(run, "projects")[1] == {"projects": [
        {"name": "alpha", "open": 1, "total": 2}, {"name": "beta", "open": 1, "total": 1}]}


def test_json_board_columns_follow_derived_status(run):
    for t in ("OPEN", "HELD", "DONE", "GONE"):
        run("create", t, "--title", t.lower(), "--body", "")
    run("claim", "HELD")
    run("close", "DONE", "--done")
    run("close", "GONE", "--cancelled")
    data = _json(run, "board")[1]
    assert _column(data, "open") == ["OPEN"]
    assert _column(data, "in_progress") == ["HELD"]
    assert _column(data, "done") == ["DONE"]
    held = data["columns"][1]["tasks"][0]
    assert held["status"] == "in_progress" and held["session"] == "selftest-session"


def test_json_board_filters_by_project(run):
    run("create", "A", "--title", "a", "--body", "", "--project", "alpha")
    run("create", "B", "--title", "b", "--body", "", "--project", "beta")
    assert _column(_json(run, "board", "--project", "alpha")[1], "open") == ["A"]


def test_json_board_done_column_shows_only_the_latest_twelve(run):
    for i in range(14):
        run("create", f"D{i:02}", "--title", "d", "--body", "")
        run("close", f"D{i:02}", "--done")
    assert len(_column(_json(run, "board")[1], "done")) == 12


def test_json_board_open_tasks_carry_their_latest_note_and_open_blockers(run):
    for t in ("HELD", "WAIT", "B1", "B2", "DONE"):
        run("create", t, "--title", t.lower(), "--body", "")
    run("block", "WAIT", "B1")
    run("block", "WAIT", "B2")
    run("close", "B2", "--done")
    run("claim", "HELD")
    run("event", "HELD", "--kind", "note", "--body", "first")
    run("event", "HELD", "--kind", "decision", "--body", "Question: q\nVerdict: v")
    run("event", "HELD", "--kind", "note", "--body", "tests pass")
    run("event", "DONE", "--kind", "note", "--body", "shipped")
    run("close", "DONE", "--done")
    tasks = {t["id"]: t for c in _json(run, "board")[1]["columns"] for t in c["tasks"]}
    assert tasks["HELD"]["progress"]["body"] == "tests pass"
    assert isinstance(tasks["HELD"]["progress"]["at"], int)
    assert tasks["WAIT"]["progress"] is None
    assert tasks["WAIT"]["blocked_by"] == ["B1"]  # B2 is done: no longer in the way
    assert tasks["HELD"]["blocked_by"] == []
    assert "progress" not in tasks["DONE"] and "blocked_by" not in tasks["DONE"]


def test_json_task_shows_body_status_and_project(run):
    run("create", "T", "--title", "能看到任务", "--body", "## Acceptance criteria\n- 可以",
        "--project", "alpha")
    code, d = _json(run, "task", "T")
    assert code == 0
    assert (d["id"], d["title"], d["status"], d["project"], d["session"]) == (
        "T", "能看到任务", "open", "alpha", None)
    assert d["body"] == "## Acceptance criteria\n- 可以"
    assert d["latest_note"] is None and d["decisions"] == [] and d["links"] == []
    assert d["created_at"] > 0


def test_json_task_shows_latest_note_decisions_and_links(run):
    run("create", "T", "--title", "t", "--body", "")
    run("event", "T", "--kind", "note", "--body", "第一步")
    run("event", "T", "--kind", "decision", "--body", "用 A · 否:B", "--by", "user")
    run("event", "T", "--kind", "link", "--body", "pr: https://example.test/pull/1")
    run("event", "T", "--kind", "note", "--body", "第二步")
    d = _json(run, "task", "T")[1]
    assert d["latest_note"]["body"] == "第二步"
    assert [(e["body"], e["author"]) for e in d["decisions"]] == [("用 A · 否:B", "user")]
    assert [e["body"] for e in d["links"]] == ["pr: https://example.test/pull/1"]
    assert [e["kind"] for e in d["events"]] == ["note", "link", "decision", "note"]


def test_json_task_status_follows_claim_and_close(run):
    run("create", "T", "--title", "t", "--body", "")
    run("claim", "T")
    d = _json(run, "task", "T")[1]
    assert (d["status"], d["session"]) == ("in_progress", "selftest-session")
    run("close", "T", "--done")
    d = _json(run, "task", "T")[1]
    assert (d["status"], d["session"]) == ("done", None)
    assert [e["kind"] for e in d["events"]] == ["status", "status"]


def test_json_task_shows_parent_children_blockers_and_dependents(run):
    run("create", "SPEC", "--title", "spec", "--body", "")
    run("create", "S-1", "--title", "one", "--body", "", "--parent", "SPEC")
    run("create", "S-2", "--title", "two", "--body", "", "--parent", "SPEC", "--blocked-by", "S-1")
    run("claim", "S-1")
    two = _json(run, "task", "S-2")[1]
    assert two["parent"] == {"id": "SPEC", "title": "spec", "status": "open"}
    assert two["blocked_by"] == [{"id": "S-1", "title": "one", "status": "in_progress"}]
    one = _json(run, "task", "S-1")[1]
    assert one["dependents"] == [{"id": "S-2", "title": "two", "status": "open"}]
    spec = _json(run, "task", "SPEC")[1]
    assert spec["parent"] is None
    assert [c["id"] for c in spec["children"]] == ["S-1", "S-2"]


def test_json_unknown_task_is_a_json_error(run):
    code, data = _json(run, "task", "NOPE")
    assert code == 1 and "NOPE" in data["error"]


def test_json_old_schema_board_is_a_json_error(run, tmp_path):
    import sqlite3
    old = tmp_path / "old.db"
    sqlite3.connect(old).execute("CREATE TABLE tasks (id TEXT)").connection.close()
    code, data = _json(run, "board", db=old)
    assert code == 1 and "不是新版看板" in data["error"]


def test_json_missing_board_is_a_json_error(run, tmp_path):
    code, data = _json(run, "board", db=tmp_path / "nope.db")
    assert code == 1 and "看板不存在" in data["error"]


def test_json_db_names_the_board_file_through_links(run, tmp_path):
    # The Herdr panel watches this file's folder; a linked board (~/nawaban/.nawaban -> ~/.nawaban)
    # changes where the link points, so the answer is the real file.
    link = tmp_path / "linked.db"
    link.symlink_to(run.board)
    assert _json(run, "db", db=link) == (0, {"db": str(run.board.resolve())})
