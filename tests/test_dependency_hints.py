"""Dependency suggestions never mutate edges or extend the shared hint budget."""

import io
import json
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import sys
import threading
import time

import pytest

from nawaban import board_view, cli, db


@pytest.fixture
def board(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="PRE", title="用户可以建立账户", project="p", epic="LOGIN")
    monkeypatch.setenv("NAWABAN_OWNER", "test")
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    return path


def create(path, *extra):
    return cli.main(["--db", str(path), "create", "NEW", "--title", "用户可以登录账户",
                     "--project", "p", *extra])


def test_commit_before_all_requests_and_only_module_is_written(board, monkeypatch, capsys):
    seen = []

    def post(request):
        with sqlite3.connect(board) as con:
            assert con.execute("SELECT epic FROM tasks WHERE id='NEW'").fetchone() == (None,)
            assert con.execute("SELECT count(*) FROM task_edges").fetchone()[0] == 0
        payload = json.loads(request.data)
        questions = payload["questions"]
        seen.append(set(questions))
        if "module" in questions:
            answers = {"module": {"probabilities": {"module_0": .99, "none": .01}}}
        elif "candidate_0" in questions:
            assert payload["state"]["candidates"]["candidate_0"]["title"] == "用户可以建立账户"
            answers = {"candidate_0": {"noul": .8}}
        else:
            answers = {name: {"noul": 1} for name in questions}
        return io.BytesIO(json.dumps({"answers": answers}).encode())

    monkeypatch.setattr(cli, "_post", post)
    assert create(board) == 0
    out = capsys.readouterr()
    assert "✓ create NEW" in out.out and "✓ 模块" in out.out
    assert "前置建议" in out.err and "PRE" in out.err
    assert len(seen) == 3
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT epic FROM tasks WHERE id='NEW'").fetchone() == ("LOGIN",)
        assert con.execute("SELECT count(*) FROM task_edges").fetchone()[0] == 0


@pytest.mark.parametrize("score,shown", [(.59, False), (.60, True), (.75, True), (True, False), (None, False)])
def test_threshold_and_explicit_module_still_allows_dependency_hint(board, monkeypatch, capsys, score, shown):
    monkeypatch.setattr(cli, "_hints", lambda *args: [])
    monkeypatch.setattr(cli, "_answers", lambda *args: {"candidate_0": {"noul": score}})
    assert create(board, "--epic", "LOGIN") == 0
    out = capsys.readouterr()
    assert ("前置建议" in out.err) == shown
    assert ("--kind depends_on" in out.err) == shown
    assert "✓ 模块" not in out.out


@pytest.mark.parametrize("entry", ["source", "legacy_symlink", "plugin"])
def test_printed_command_runs_unchanged_on_the_same_board(board, monkeypatch, capsys, tmp_path, entry):
    source = Path(cli.__file__).absolute()
    if entry == "plugin":
        package = tmp_path / "plugin space's $dir" / "nawaban"
        shutil.copytree(source.parent, package,
                        ignore=shutil.ignore_patterns("webui", "__pycache__"))
        entrypoint = package / "cli.py"
        monkeypatch.setattr(cli, "__file__", str(entrypoint))
    elif entry == "legacy_symlink":
        entrypoint = tmp_path / f"{entry} space's $dir" / "cli.py"
        entrypoint.parent.mkdir()
        entrypoint.symlink_to(source)
        monkeypatch.setattr(cli, "__file__", str(entrypoint))
    else:
        entrypoint = source
    selected = tmp_path / "board space's $(false).db"
    selected.symlink_to(board)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, "_hints", lambda *args: [])
    monkeypatch.setattr(cli, "_answers", lambda *args: {"candidate_0": {"noul": .8}})
    assert create(Path(selected.name), "--epic", "LOGIN") == 0
    lines = capsys.readouterr().err.splitlines()
    assert len(lines) == 2
    command = lines[1].strip()
    assert shlex.split(command) == [sys.executable, str(entrypoint), "--db", str(selected),
                                   "link", "--kind", "depends_on", "--", "NEW", "PRE"]
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT count(*) FROM task_edges").fetchone()[0] == 0
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    result = subprocess.run(command, shell=True, cwd=elsewhere, text=True,
                            capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT src,dst,kind FROM task_edges").fetchall() == [
            ("NEW", "PRE", "depends_on")]
    graph = board_view.graph_data(board)
    assert any(edge["source"] == "PRE" and edge["target"] == "NEW"
               and edge["kind"] == "depends_on" for edge in graph["links"])


@pytest.mark.parametrize("prerequisite,task_id", [
    ("PRE-账户🧭\n\x1b[31m", "NEW\t\x7f"), ("-PRE", "-NEW"),
])
def test_special_ids_round_trip_without_terminal_controls(board, monkeypatch, tmp_path,
                                                         prerequisite, task_id):
    with sqlite3.connect(board) as con:
        con.execute("UPDATE tasks SET id=? WHERE id='PRE'", (prerequisite,))
    db.create_task(board, task_id=task_id, title="用户可以登录账户", project="p")
    monkeypatch.setattr(cli, "_answers", lambda *args: {"candidate_0": {"noul": .8}})
    hint = cli._dependency_hint(board, task_id)
    command = hint.partition("\n")[2].strip()
    assert command.isprintable()
    result = subprocess.run(command, shell=True, cwd=tmp_path, text=True,
                            capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT src,dst,kind FROM task_edges").fetchall() == [
            (task_id, prerequisite, "depends_on")]


def test_cap_same_project_and_only_unfinished_candidates(board, monkeypatch, capsys):
    with sqlite3.connect(board) as con:
        for i in range(30):
            con.execute("INSERT INTO tasks(id,title,project,epic,created_at) VALUES(?,?,?,?,?)",
                        (f"OLD-{i:02}", "用户可以打开页面", "p", "OTHER", i))
        for identifier, project, status in [("OTHER", "q", "open"), ("DONE", "p", "done"),
                                             ("CANCEL", "p", "cancelled")]:
            con.execute("INSERT INTO tasks(id,title,project,status,created_at) VALUES(?,?,?,?,0)",
                        (identifier, identifier, project, status))
    monkeypatch.setattr(cli, "_hints", lambda *args: [])

    def answers(state, questions):
        assert len(questions) == 25
        titles = [v["title"] for v in state["candidates"].values()]
        assert "用户可以建立账户" == titles[0]
        assert not {"OTHER", "DONE", "CANCEL"} & set(titles)
        return {name: {"noul": .8} for name in questions}

    monkeypatch.setattr(cli, "_answers", answers)
    assert create(board, "--epic", "LOGIN") == 0
    assert capsys.readouterr().err.count("前置建议") == 1


@pytest.mark.parametrize("mode", ["no_key", "network", "malformed", "db_read"])
def test_failures_are_silent_and_leave_one_committed_card(board, monkeypatch, capsys, mode):
    monkeypatch.setattr(cli, "_hints", lambda *args: [])
    if mode == "no_key":
        monkeypatch.delenv("TYPESAFE_API_KEY")
        monkeypatch.setattr(cli, "_post", pytest.fail)
    elif mode == "db_read":
        original = cli.sqlite3.connect

        def connect(*args, **kwargs):
            if kwargs.get("uri"):
                raise sqlite3.OperationalError("locked")
            return original(*args, **kwargs)

        monkeypatch.setattr(cli.sqlite3, "connect", connect)
    elif mode == "network":
        def post(*args):
            raise OSError("offline")
        monkeypatch.setattr(cli, "_post", post)
    else:
        monkeypatch.setattr(cli, "_post", lambda *args: io.BytesIO(b"bad json"))
    assert create(board, "--epic", "LOGIN") == 0
    assert capsys.readouterr().err == ""
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT count(*) FROM tasks WHERE id='NEW'").fetchone()[0] == 1
        assert con.execute("SELECT count(*) FROM task_edges").fetchone()[0] == 0


def test_shared_budget_covers_module_and_stalled_dependency(board, monkeypatch, capsys):
    blocked, release, finished = threading.Event(), threading.Event(), threading.Event()
    monkeypatch.setattr(cli, "_HINT_DEADLINE_S", 1.2)
    monkeypatch.setattr(cli, "_hints", lambda *args: ["completed title hint"])
    monkeypatch.setattr(cli, "_epic_pick", lambda *args: time.sleep(.12) or ("LOGIN", .95))

    def stall(*args):
        blocked.set()
        release.wait(2)
        finished.set()
        return "late dependency hint"

    monkeypatch.setattr(cli, "_dependency_hint", stall)
    durations = []
    original = cli._create_hints

    def measure(*args, **kwargs):
        start = time.monotonic()
        result = original(*args, **kwargs)
        durations.append(time.monotonic() - start)
        return result

    monkeypatch.setattr(cli, "_create_hints", measure)
    try:
        assert create(board) == 0
        assert blocked.is_set()
        assert .6 <= durations[0] < 1.2
        out = capsys.readouterr()
        assert "completed title hint" in out.err and "✓ 模块" in out.out
        assert "late dependency hint" not in out.err
        with sqlite3.connect(board) as con:
            assert con.execute("SELECT count(*) FROM tasks WHERE id='NEW'").fetchone()[0] == 1
    finally:
        release.set()
        assert finished.wait(1)
    assert capsys.readouterr().err == ""


def test_expired_budget_does_not_start_more_requests(board, monkeypatch):
    release = threading.Event()
    monkeypatch.setattr(cli, "_HINT_DEADLINE_S", .6)

    def stall(*args):
        release.wait(1)
        return []

    monkeypatch.setattr(cli, "_hints", stall)
    calls = []
    monkeypatch.setattr(cli, "_epic_pick", lambda *args: calls.append("module"))
    monkeypatch.setattr(cli, "_dependency_hint", lambda *args: calls.append("dependency"))
    try:
        assert create(board) == 0
    finally:
        release.set()
    # Joining the actual advisory thread establishes completion before checking.
    for thread in threading.enumerate():
        if thread.name.endswith("(collect)"):
            thread.join(1)
    assert calls == []


def test_stalled_network_cannot_keep_cli_process_alive(board):
    program = """
import sys, time
from nawaban import cli
cli._post = lambda request: time.sleep(30)
raise SystemExit(cli.main(['--db', sys.argv[1], 'create', 'NEW', '--title', '用户可以登录账户', '--project', 'p']))
"""
    start = time.monotonic()
    result = subprocess.run([sys.executable, "-c", program, str(board)],
                            text=True, capture_output=True, timeout=6)
    elapsed = time.monotonic() - start
    assert result.returncode == 0 and "✓ create NEW" in result.stdout
    assert result.stderr == ""
    # Includes interpreter/CLI startup in addition to the 4.5-second hint wait.
    assert elapsed < 5.5
