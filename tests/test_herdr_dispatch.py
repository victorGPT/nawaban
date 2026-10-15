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


def record_id(board) -> int:
    with sqlite3.connect(board) as con:
        return con.execute("SELECT MAX(id) FROM task_events WHERE body LIKE 'dispatch {%'").fetchone()[0]


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
    assert cmd[1:] == ["-m", "nawaban.dispatch", "watch", str(board), "P-1", str(record_id(board))]
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
    dispatch.watch(watched, "P-1", record_id(watched))
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
    dispatch.watch(watched, "P-1", record_id(watched))
    with sqlite3.connect(watched) as con:
        assert not con.execute("SELECT 1 FROM task_events WHERE body LIKE 'pane closed%'").fetchall()
        assert not con.execute("SELECT 1 FROM letters").fetchall()


NEW = "dddddddd-1111-2222-3333-444444444444"


def redispatch(board, *, dismiss=True):
    """上一次派发收工(或不收工直接改派),同一张卡再派给新的 worker。"""
    if dismiss:
        db.add_event(board, "P-1", kind="coord", author="ac:x", body="dismiss · 窗格 w1:p9 已关")
    new = {"backend": "herdr", "session": NEW, "pane": "w1:p10", "tab": "w1:t10",
           "worktree": "/wt", "root": "/", "director": DIRECTOR}
    db.add_event(board, "P-1", kind="coord", author="ac:x", body="dispatch " + json.dumps(new))


def pane_closed(board) -> list:
    with sqlite3.connect(board) as con:
        return con.execute("SELECT body FROM task_events WHERE body LIKE 'pane closed%'").fetchall()


def handed_back(board):
    """上一个 worker 交接并把卡放回待办。"""
    db.claim_task(board, "P-1", owner="ac:w", session_id=WORKER)
    db.start_task(board, "P-1", owner="ac:w", session_id=WORKER, now="在做")
    db.handoff(board, "P-1", owner="ac:w", session_id=WORKER, outcome="handed_off",
               summary="交接", now="放回待办", release=True)


@pytest.mark.parametrize("dismiss", [True, False])
def test_an_old_watcher_stays_silent_once_its_dispatch_is_replaced(watched, monkeypatch, dismiss):
    first = record_id(watched)

    def meanwhile(pane):  # 旧窗格关掉之前,这张卡已经收工或改派,新 worker 认领并开工
        redispatch(watched, dismiss=dismiss)
        db.claim_task(watched, "P-1", owner="ac:new", session_id=NEW)
        db.add_event(watched, "P-1", kind="note", author="ac:new", body="开工", now="新 worker 在做")
    monkeypatch.setattr(dispatch, "_wait_closed", meanwhile)
    dispatch.watch(watched, "P-1", first)
    assert not pane_closed(watched)
    with sqlite3.connect(watched) as con:
        assert not con.execute("SELECT 1 FROM letters").fetchall()
        assert con.execute("SELECT now FROM tasks WHERE id='P-1'").fetchone()[0] == "新 worker 在做"


def test_a_late_old_watcher_never_watches_the_new_worker(watched, monkeypatch):
    first = record_id(watched)
    redispatch(watched)
    waited = []
    monkeypatch.setattr(dispatch, "_wait_closed", waited.append)
    dispatch.watch(watched, "P-1", first)
    assert not waited and not pane_closed(watched)


def test_a_new_worker_closed_before_claiming_is_reported_despite_the_old_handoff(watched):
    handed_back(watched)
    redispatch(watched)
    dispatch.watch(watched, "P-1", record_id(watched))
    [(body,)] = pane_closed(watched)
    assert "w1:p10" in body
    with sqlite3.connect(watched) as con:
        assert con.execute("SELECT session_id FROM letters").fetchall() == [(NEW,)]


def test_dismiss_does_not_count_the_previous_workers_handoff(watched, capsys):
    handed_back(watched)
    redispatch(watched)
    assert run(watched, "dismiss", "P-1") == 1
    assert "卡还没完成也没交接" in capsys.readouterr().err


def test_a_pane_closed_in_the_dispatch_second_still_wakes_the_director(board, herdr, monkeypatch):
    clock = [1_800_000_000]
    monkeypatch.setattr(db, "_now", lambda: clock[0])
    monkeypatch.setattr(dispatch.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + 1))
    monkeypatch.setattr(dispatch, "_wait_closed", lambda pane: None)
    assert run(board, "dispatch", "P-1") == 0
    dispatch.watch(board, "P-1", record_id(board))
    _, directing = report.roles(board, DIRECTOR)
    assert report.take(board, {t: ("turn", *peer) for t, peer in directing.items()})


def test_a_relative_board_path_reaches_the_watcher_as_absolute(tmp_path, herdr, monkeypatch):
    monkeypatch.chdir(tmp_path)
    dispatch._spawn_watch(Path("board.db"), "P-1", 7)
    [(cmd, _)] = herdr.spawned
    assert cmd[4] == str(tmp_path.resolve() / "board.db")


@pytest.mark.parametrize("code,alive", [
    ("pane_not_found", False), ("server_not_running", False), ("timeout", True), ("", True)])
def test_only_herdr_saying_the_pane_is_gone_counts_as_gone(monkeypatch, code, alive):
    out = json.dumps({"error": {"code": code}}) if code else "garbled"
    monkeypatch.setattr(dispatch, "RUN", lambda cmd, **_: subprocess.CompletedProcess(cmd, 1, out, ""))
    assert dispatch._alive("w1:p9") is alive


def answers(monkeypatch, *values):
    left = list(values)
    monkeypatch.setattr(dispatch, "_alive", lambda pane: left.pop(0))
    monkeypatch.setattr(dispatch, "_SOCKET", "/nonexistent/herdr.sock")
    monkeypatch.setattr(dispatch.time, "sleep", lambda seconds: None)
    return left


def test_wait_closed_returns_once_the_pane_is_gone_even_without_a_socket(monkeypatch):
    left = answers(monkeypatch, True, True, False, False)
    dispatch._wait_closed("w1:p9")
    assert not left


def test_a_herdr_restart_gap_is_not_taken_for_a_closed_pane(monkeypatch):
    # 没了 → 再看还在(重启的间隙)→ 接着守 → 真没了 → 再看还是没了
    left = answers(monkeypatch, False, True, True, False, False, False)
    dispatch._wait_closed("w1:p9")
    assert not left


def test_director_skill_says_not_to_mark_agents_blocked_in_herdr():
    text = (ROOT / "skills/nawaban-director/SKILL.md").read_text(encoding="utf-8")
    section = text.split("## Notifications and replies", 1)[1].split("\n## ", 1)[0]
    assert "report-agent" in section and "agent_blocked" in section
