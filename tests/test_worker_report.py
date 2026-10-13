"""A dispatched worker's last words reach its director when it stops, and the reply comes back."""

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nawaban import cli, db  # noqa: E402

spec = importlib.util.spec_from_file_location("worker_report", ROOT / "hooks" / "worker_report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

WORKER = "aaaaaaaa-1111-2222-3333-444444444444"
DIRECTOR = "bbbbbbbb-1111-2222-3333-444444444444"
STRANGER = "cccccccc-1111-2222-3333-444444444444"


@pytest.fixture
def board(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-1", title="用户能看到 worker 的回报")
    monkeypatch.setenv("NAWABAN_DB", str(path))
    monkeypatch.setenv("NAWABAN_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.delenv("CLAUDE_PID", raising=False)
    return path


def dispatched(board, *, director=DIRECTOR):
    record = {"backend": "claude-bg", "session": WORKER, "pane": None, "director": director}
    db.add_event(board, "P-1", kind="coord", author="ac:x",
                 body="dispatch " + json.dumps(record))


def letters(board) -> list[tuple]:
    with sqlite3.connect(board) as con:
        return con.execute("SELECT kind, msg, session_id, read_at IS NOT NULL FROM letters"
                           " ORDER BY id").fetchall()


def stop(session, said="做完了") -> dict:
    return {"session_id": session, "last_assistant_message": said, "hook_event_name": "Stop"}


def no_waiting(monkeypatch, then=lambda: None):
    """Fail the test instead of polling forever; `then` runs once in place of the first sleep."""
    calls = []

    def sleep(seconds):
        if calls:
            raise AssertionError("钩子在空等")
        calls.append(seconds)
        then()
    monkeypatch.setattr(report.time, "sleep", sleep)


def test_worker_stop_sends_its_last_message_then_wakes_on_the_reply(board, monkeypatch, capsys):
    dispatched(board)
    no_waiting(monkeypatch, then=lambda: cli.main(
        ["--db", str(board), "notify", "P-1", "--kind", "reply", "--msg", "用方案 B,继续"]))
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", DIRECTOR)
    assert report.run(stop(WORKER, "方案 A 还是 B?我建议 B")) == report.WAKE
    assert letters(board) == [("turn", "方案 A 还是 B?我建议 B", WORKER, 0),
                              ("reply", "用方案 B,继续", DIRECTOR, 1)]
    woke = capsys.readouterr().err
    assert "用方案 B,继续" in woke and "主控回话 · P-1" in woke


def test_director_wakes_with_the_worker_message_and_the_escalation_rule(board, monkeypatch, capsys):
    dispatched(board)
    db.add_letter(board, "P-1", kind="turn", msg="方案 A 还是 B?", session_id=WORKER)
    db.add_letter(board, "P-1", kind="done", msg="PR 已开", session_id=WORKER)
    no_waiting(monkeypatch)
    assert report.run(stop(DIRECTOR, "已派出")) == report.WAKE
    woke = capsys.readouterr().err
    assert "方案 A 还是 B?" in woke and "P-1" in woke and "--kind reply" in woke
    assert "产品语义分叉、对外承诺、生产发布" in woke and "ask 转给用户" in woke
    # 主控自己停下时说的话不外送;别的种类的信留给原有的收信流程。
    assert letters(board) == [("turn", "方案 A 还是 B?", WORKER, 1), ("done", "PR 已开", WORKER, 0)]


def test_a_letter_is_delivered_once(board):
    dispatched(board)
    db.add_letter(board, "P-1", kind="turn", msg="第一轮", session_id=WORKER)
    wanted = {"P-1": ("turn", WORKER, 0)}
    assert report.take(board, wanted) == [("P-1", "第一轮")]
    assert report.take(board, wanted) == []


def test_a_new_dispatch_does_not_inherit_the_old_pair_s_letters(board, monkeypatch):
    dispatched(board)
    db.add_letter(board, "P-1", kind="reply", msg="旧主控的决定", session_id="old-director")
    db.add_letter(board, "P-1", kind="reply", msg="上一次派发时回的", session_id=DIRECTOR)
    with sqlite3.connect(board) as con:
        con.execute("UPDATE letters SET created_at=created_at-100")
    no_waiting(monkeypatch, then=lambda: db.add_event(
        board, "P-1", kind="coord", author="ac:x", body="dismiss · 已停"))
    assert report.run(stop(WORKER)) == 0  # 没收到旧信;收工后也不再等
    assert [row[3] for row in letters(board)] == [0, 0, 0]


def test_a_waiting_director_stops_once_the_worker_is_dismissed(board, monkeypatch):
    dispatched(board)

    def dismiss_then_report():
        db.add_event(board, "P-1", kind="coord", author="ac:x", body="dismiss · 已停")
        db.add_letter(board, "P-1", kind="turn", msg="收工后的话", session_id=WORKER)
    no_waiting(monkeypatch, then=dismiss_then_report)
    assert report.run(stop(DIRECTOR)) == 0
    assert letters(board) == [("turn", "收工后的话", WORKER, 0)]


def test_a_session_nobody_dispatched_sends_nothing(board, monkeypatch, capsys):
    dispatched(board)
    no_waiting(monkeypatch, then=lambda: pytest.fail("普通会话不该等信"))
    before = list(sqlite3.connect(board).iterdump())
    assert report.run(stop(STRANGER, "随便说点什么")) == 0
    assert list(sqlite3.connect(board).iterdump()) == before
    assert capsys.readouterr().err == ""
    assert not (Path(report.paths.state_dir()) / "report-wait").exists()


@pytest.mark.parametrize("dismissed", [True, False],
                         ids=["dismissed", "dispatched-before-directors-were-recorded"])
def test_no_live_director_means_nothing_is_sent(board, monkeypatch, dismissed):
    dispatched(board, director=DIRECTOR if dismissed else None)
    if dismissed:
        db.add_event(board, "P-1", kind="coord", author="ac:x", body="dismiss · 已停")
    no_waiting(monkeypatch, then=lambda: pytest.fail("不该等信"))
    assert report.run(stop(WORKER)) == 0
    assert letters(board) == []


def test_without_a_board_the_hook_does_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("NAWABAN_DB", str(tmp_path / "missing.db"))
    assert report.run(stop(WORKER)) == 0
    assert not (tmp_path / "missing.db").exists()


def test_long_messages_are_cut_and_say_so(board, monkeypatch):
    dispatched(board)
    said = "头" * 1000 + "腰" * 4000 + "尾" * 500
    no_waiting(monkeypatch, then=lambda: (report.paths.state_dir() / "report-wait"
                                          / f"{WORKER}.pid").write_text("0"))
    assert report.run(stop(WORKER, said)) == 0  # 被更新的等待者顶替后退出
    [(kind, msg, _, _)] = letters(board)
    assert kind == "turn" and len(msg) == report.LIMIT
    assert msg.startswith("头" * 1000) and msg.endswith("尾" * 400) and "腰" not in msg
    assert "已截断:原文 5500 字,只送开头和结尾" in msg
    assert report.clip("短话") == "短话"


def test_main_survives_bad_input(monkeypatch):
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO("not json"))
    assert report.main() == 0
