"""Herdr dispatch: every worker gets going on its own, nothing lands in the director's pane,
and a worker pane closed before the card is finished reaches the director."""

import importlib.util
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nawaban import cli, db, dispatch  # noqa: E402

spec = importlib.util.spec_from_file_location("worker_report", ROOT / "hooks" / "worker_report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

WORKER = "aaaaaaaa-1111-2222-3333-444444444444"
DIRECTOR = "bbbbbbbb-1111-2222-3333-444444444444"
STALLED = json.dumps({"error": {"code": "agent_prompt_stalled"}})


class Herdr:
    """Stands in for git, claude and herdr; `answers` scripts the replies to prompt / wait."""

    def __init__(self, root: Path, answers=()):
        self.root, self.answers = root, list(answers)
        self.calls: list[tuple[list[str], dict | None]] = []
        self.spawned: list[tuple[list[str], dict]] = []

    def __call__(self, cmd, env=None, **_):
        self.calls.append((cmd, env))
        out, code = "", 0
        if cmd[:3] == ["herdr", "tab", "create"]:
            out = json.dumps({"result": {"root_pane": {"pane_id": "w1:p9"},
                                         "tab": {"tab_id": "w1:t9"}}})
        elif cmd[:3] in (["herdr", "agent", "prompt"], ["herdr", "agent", "wait"]):
            code, out = self.answers.pop(0) if self.answers else (0, "{}")
        elif cmd[:2] == ["claude", "agents"]:
            # 起过会话、之后没关 tab(关 tab 会带走里面的会话)才算活着
            alive = False
            for c, _ in self.calls:
                if c[:3] == ["herdr", "agent", "start"] or c[:2] == ["claude", "--bg"]:
                    alive = True
                elif c[:3] == ["herdr", "tab", "close"]:
                    alive = False
            out = json.dumps([{"name": "p-1", "sessionId": WORKER,
                               "cwd": str(self.root / ".claude/worktrees/p-1")}] if alive else [])
        elif "--git-common-dir" in cmd:
            out = str(self.root / ".git")
        return subprocess.CompletedProcess(cmd, code, out, "")

    def ran(self, *prefix) -> list[list[str]]:
        return [c for c, _ in self.calls if c[:len(prefix)] == list(prefix)]


@pytest.fixture
def board(tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-1", title="用户能派出一张卡")
    return path


@pytest.fixture
def herdr(tmp_path, monkeypatch):
    fake = Herdr(tmp_path)
    monkeypatch.setattr(dispatch, "RUN", fake)
    monkeypatch.setattr(dispatch, "SPAWN", lambda cmd, **kw: fake.spawned.append((cmd, kw)))
    monkeypatch.setattr(dispatch, "_trusted", lambda root: True)
    monkeypatch.setattr(dispatch.time, "sleep", lambda seconds: None)
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setenv("HERDR_PANE_ID", "w1:p1")
    monkeypatch.setenv("HERDR_TAB_ID", "w1:t1")
    monkeypatch.setenv("HERDR_WORKSPACE_ID", "w1")
    monkeypatch.setenv("HERDR_SESSION", "main")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", DIRECTOR)
    return fake


def run(board, *argv) -> int:
    return cli.main(["--db", str(board), *argv])


def record(board) -> dict:
    with sqlite3.connect(board) as con:
        [(body,)] = con.execute("SELECT body FROM task_events WHERE body LIKE 'dispatch {%'")
    return json.loads(body[len("dispatch "):])


def test_prompt_is_sent_once_and_waits_for_the_worker_to_start(board, herdr):
    assert run(board, "dispatch", "P-1") == 0
    [prompt] = herdr.ran("herdr", "agent", "prompt")
    assert prompt[3] == "w1:p9" and "只做一张卡:P-1" in prompt[4]
    assert prompt[5:] == ["--wait", "--until", "working", "--until", "blocked", "--timeout", "15000"]
    assert not herdr.ran("herdr", "agent", "send-keys")
    assert record(board)["pane"] == "w1:p9" and record(board)["tab"] == "w1:t9"


def test_a_lost_enter_is_pressed_again_without_retyping(board, herdr):
    herdr.answers = [(1, STALLED), (1, json.dumps({"error": {"code": "timeout"}})), (0, "{}")]
    assert run(board, "dispatch", "P-1") == 0
    assert len(herdr.ran("herdr", "agent", "prompt")) == 1
    assert herdr.ran("herdr", "agent", "send-keys") == [["herdr", "agent", "send-keys", "w1:p9", "enter"]] * 2
    assert not herdr.ran("herdr", "tab", "close") and not herdr.ran("claude", "--bg")


def test_a_worker_that_never_starts_gives_up_after_three_enters(board, herdr):
    herdr.answers = [(1, STALLED)] * 4
    assert run(board, "dispatch", "P-1") == 0
    assert len(herdr.ran("herdr", "agent", "send-keys")) == 3
    assert herdr.ran("herdr", "tab", "close", "w1:t9")
    assert herdr.ran("claude", "--bg")  # tab 关掉后改走后台会话


def test_enter_is_never_pressed_into_a_blocked_dialog(board, herdr):
    herdr.answers = [(1, json.dumps({"error": {"code": "agent_blocked"}}))]
    run(board, "dispatch", "P-1")
    assert not herdr.ran("herdr", "agent", "send-keys")
    assert herdr.ran("herdr", "tab", "close", "w1:t9")


def test_herdr_never_sees_the_director_pane(board, herdr):
    assert run(board, "dispatch", "P-1") == 0
    herdr_calls = [(c, env) for c, env in herdr.calls if c[0] == "herdr"]
    assert herdr_calls
    for _, env in herdr_calls:
        assert not set(env) & {"HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION"}
    [create] = herdr.ran("herdr", "tab", "create")
    assert create[3:5] == ["--workspace", "w1"] and "--no-focus" in create
    assert not herdr.ran("herdr", "pane", "split")
    [(_, env)] = [(c, kw["env"]) for c, kw in herdr.spawned]
    assert "HERDR_PANE_ID" not in env


def test_dispatch_starts_a_detached_pane_watcher(board, herdr):
    assert run(board, "dispatch", "P-1") == 0
    [(cmd, kw)] = herdr.spawned
    assert cmd[1:] == ["-m", "nawaban.dispatch", "watch", str(board), "P-1"]
    assert kw["start_new_session"] and kw["cwd"] == ROOT


def test_a_background_worker_gets_no_pane_watcher(board, herdr, monkeypatch):
    monkeypatch.delenv("HERDR_ENV")
    assert run(board, "dispatch", "P-1") == 0
    assert not herdr.spawned


@pytest.fixture
def watched(board, herdr, monkeypatch):
    clock = db._now
    monkeypatch.setattr(db, "_now", lambda: clock() - 1)  # 派发早于之后的信
    assert run(board, "dispatch", "P-1") == 0
    monkeypatch.setattr(db, "_now", clock)
    monkeypatch.setattr(dispatch, "_wait_closed", lambda pane: None)
    return board


def test_closing_an_unfinished_worker_pane_wakes_the_director(watched):
    db.claim_task(watched, "P-1", owner="ac:w", session_id=WORKER)
    dispatch.watch(watched, "P-1")
    with sqlite3.connect(watched) as con:
        [(body,)] = con.execute("SELECT body FROM task_events WHERE body LIKE 'pane closed%'")
        [(now,)] = con.execute("SELECT now FROM tasks WHERE id='P-1'")
    assert "w1:p9" in body and "claimed" in body and "w1:p9" in now
    _, directing = report.roles(watched, DIRECTOR)
    [(task_id, msg)] = report.take(watched, {t: ("turn", *peer) for t, peer in directing.items()})
    assert task_id == "P-1" and "被关掉了" in msg


@pytest.mark.parametrize("finish", ["done", "handed_off"])
def test_closing_a_finished_worker_pane_is_silent(watched, finish):
    db.claim_task(watched, "P-1", owner="ac:w", session_id=WORKER)
    db.start_task(watched, "P-1", owner="ac:w", session_id=WORKER, now="在做")
    if finish == "done":
        with sqlite3.connect(watched) as con:
            con.execute("UPDATE tasks SET status='done' WHERE id='P-1'")
    else:
        db.handoff(watched, "P-1", owner="ac:w", session_id=WORKER, outcome="handed_off",
                   summary="交接", now="等评审")
    dispatch.watch(watched, "P-1")
    with sqlite3.connect(watched) as con:
        assert not con.execute("SELECT 1 FROM task_events WHERE body LIKE 'pane closed%'").fetchall()
        assert not con.execute("SELECT 1 FROM letters").fetchall()


def test_wait_closed_returns_once_the_pane_is_gone_even_without_a_socket(monkeypatch):
    alive = iter([True, True, False])
    monkeypatch.setattr(dispatch, "_alive", lambda pane: next(alive))
    monkeypatch.setattr(dispatch, "_SOCKET", "/nonexistent/herdr.sock")
    monkeypatch.setattr(dispatch.time, "sleep", lambda seconds: None)
    dispatch._wait_closed("w1:p9")


def test_director_skill_says_not_to_mark_agents_blocked_in_herdr():
    text = (ROOT / "skills/nawaban-director/SKILL.md").read_text(encoding="utf-8")
    section = text.split("## Notifications and replies", 1)[1].split("\n## ", 1)[0]
    assert "report-agent" in section and "agent_blocked" in section
