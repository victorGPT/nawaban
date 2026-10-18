"""The new tracker CLI, driven against a temporary board (spec NAWABAN-LEAN, seam 1)."""

import pytest

from nawaban import tracker


@pytest.fixture
def run(tmp_path, capsys):
    board = tmp_path / "proj" / ".nawaban" / "board.db"

    def run(*args, db=board):
        code = tracker.main(["--db", str(db), *args])
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


def test_project_defaults_to_the_board_directory_the_command_runs_in(run, tmp_path, monkeypatch):
    shared = tmp_path / "shared" / "board.db"
    assert run("init", db=shared)[0] == 0
    repo = tmp_path / "myrepo"
    (repo / ".nawaban").mkdir(parents=True)
    (repo / "sub").mkdir()
    monkeypatch.chdir(repo / "sub")
    run("create", "T", "--title", "t", "--body", "b", db=shared)
    assert "项目 myrepo" in run("show", "T", db=shared)[1]


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
    assert "当前进度:第二步" in out
    assert out.index("第二步", out.index("最近事件")) < out.index("第一步")


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
    assert "被阻塞于:A open" in run("show", "B")[1]
    assert "解锁:B open" in run("show", "A")[1]


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
    assert "被阻塞于" not in run("show", "A")[1]


def test_create_with_blocked_by(run):
    _tasks(run, "A", "B")
    assert run("create", "C", "--title", "c", "--body", "b", "--blocked-by", "A", "--blocked-by", "B")[0] == 0
    out = run("show", "C")[1]
    assert "A open" in out and "B open" in out


def test_create_with_unknown_blocker_creates_nothing(run):
    _tasks(run, "A")
    code, _, err = run("create", "C", "--title", "c", "--body", "b", "--blocked-by", "A", "--blocked-by", "NOPE")
    assert code == 1 and "NOPE" in err
    assert "C" not in _ids(run("list")[1])
    assert "解锁" not in run("show", "A")[1]


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
    assert "状态 in_progress" in shown and "会话 selftest-session" in shown
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
    assert "会话 selftest-session" in run("show", "T")[1]


def test_take_moves_the_claim_and_records_an_event(run, monkeypatch):
    _tasks(run, "T")
    run("claim", "T")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "other-session")
    assert run("claim", "T", "--take")[0] == 0
    out = run("show", "T")[1]
    assert "会话 other-session" in out
    assert "status · other-session] in_progress→in_progress · 接手自 selftest-session" in out


def test_release_returns_task_to_frontier(run):
    _tasks(run, "T")
    run("claim", "T")
    assert "T" not in _ids(run("list", "--frontier")[1])
    assert run("claim", "T", "--release")[0] == 0
    out = run("show", "T")[1]
    assert "状态 open" in out and "会话" not in out and "in_progress→open" in out
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
    assert "会话" not in run("show", "T")[1]


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
    assert "状态 done" in out and "会话" not in out and "in_progress→done" in out
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
