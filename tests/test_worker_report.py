"""A dispatched worker's last words go to its director over SendMessage, and every message is recorded."""

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nawaban import db  # noqa: E402

spec = importlib.util.spec_from_file_location("worker_report", ROOT / "hooks" / "worker_report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

WORKER = "aaaaaaaa-1111-2222-3333-444444444444"
DIRECTOR = "bbbbbbbb-1111-2222-3333-444444444444"
STRANGER = "cccccccc-1111-2222-3333-444444444444"
UNREACHABLE = {"success": False, "message": "No agent named 'x' is reachable. Did you mean: y?\n"
                                            "Use ListAgents to see everyone you can message."}
SENT = {"success": True, "message": "sent", "msg_id": "m1"}


@pytest.fixture
def board(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-1", title="用户能看到 worker 的回报")
    monkeypatch.setenv("NAWABAN_DB", str(path))
    monkeypatch.setenv("NAWABAN_STATE_DIR", str(tmp_path / "state"))
    live(monkeypatch, {DIRECTOR: "nawaban-aa", WORKER: "p-1"})
    return path


def live(monkeypatch, sessions: dict):
    """The sessions `claude agents --json` would list: session ID → name."""
    monkeypatch.setattr(report.dispatch, "_agents", lambda: [
        {"sessionId": sid, "name": name} for sid, name in sessions.items()])


def dispatched(board, *, director=DIRECTOR, asks=0, name="p-1", task="P-1"):
    record = {"backend": "claude-bg", "session": WORKER, "pane": None, "director": director}
    if asks is not None:  # None = 记 ask 编号之前的旧派发记录
        record["asks"] = asks
    if name:  # None = 记名字之前的旧派发记录
        record["name"] = name
    clock = db._now
    db._now = lambda: clock() - 1  # 派发早于之后的信;同一秒内的信不算这次派发的
    try:
        db.add_event(board, task, kind="coord", author="ac:x",
                     body="dispatch " + json.dumps(record))
    finally:
        db._now = clock


def letters(board) -> list[tuple]:
    with sqlite3.connect(board) as con:
        return con.execute("SELECT kind, msg, session_id, read_at IS NOT NULL FROM letters"
                           " ORDER BY id").fetchall()


def stop(session, said="做完了", transcript=None, again=False) -> dict:
    return {"session_id": session, "last_assistant_message": said, "hook_event_name": "Stop",
            "transcript_path": transcript, "stop_hook_active": again}


def send(session, to, message, result) -> dict:
    return {"session_id": session, "hook_event_name": "PostToolUse", "tool_name": "SendMessage",
            "tool_input": {"to": to, "message": message}, "tool_response": result}


def hook(payload, capsys) -> dict | None:
    """Run the hook; return the JSON it printed, or None when it printed nothing."""
    assert report.run(payload) == 0
    out = capsys.readouterr().out
    return json.loads(out) if out else None


def stop_worker(board, monkeypatch, said="PR 已开,测试全绿", transcript=None) -> str:
    """Let the worker stop once; return the turn letter it left for the director."""
    report.run(stop(WORKER, said, transcript))
    return [msg for kind, msg, _, _ in letters(board) if kind == "turn"][-1]


def test_a_worker_stop_records_the_turn_and_has_the_worker_send_it(board, capsys):
    dispatched(board)
    out = hook(stop(WORKER, "PR 已开,测试全绿"), capsys)
    assert letters(board) == [("turn", "[待 review] PR 已开,测试全绿", WORKER, 0)]
    assert out["decision"] == "block"
    reason = out["reason"]
    assert 'SendMessage' in reason and 'to 写 "nawaban-aa"' in reason
    body = reason.split("<<<\n")[1].split("\n>>>")[0]
    assert body.startswith("[nawaban] worker 回报 · P-1")
    assert "[待 review] PR 已开,测试全绿" in body
    # 主控收到的话里写清它该怎么处理:派 review worker、怎么回话、哪三类不自己回。
    assert "-REVIEW" in body and "主控不审也不合" in body and "merge_sha" in body
    assert 'SendMessage 回给它(to 写 "p-1")' in body
    assert "产品语义分叉、对外承诺、生产发布" in body and "ask 转给用户" in body
    assert "不要重试" in reason and "不要" in reason and "别的会话" in reason


def test_the_stop_after_sending_passes_and_writes_nothing(board, capsys):
    dispatched(board)
    hook(stop(WORKER), capsys)
    assert hook(stop(WORKER, "已发给主控", again=True), capsys) is None
    assert [k for k, *_ in letters(board)] == ["turn"]
    # 下一轮又是正常的一轮
    assert hook(stop(WORKER, "第二轮"), capsys)["decision"] == "block"
    assert [m for _, m, _, _ in letters(board)][-1] == "[待 review] 第二轮"


def test_a_stop_blocked_by_another_hook_still_reports(board, capsys):
    dispatched(board)
    out = hook(stop(WORKER, "编译修好了", again=True), capsys)
    assert out["decision"] == "block"
    assert letters(board) == [("turn", "[待 review] 编译修好了", WORKER, 0)]


def tool_use(name) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_x", "name": name, "input": {}}]}}


@pytest.mark.parametrize("tools,reported", [
    (["Bash", "Edit"], True), (["ToolSearch", "SendMessage"], False), ([], False)],
    ids=["worked after the block", "only sent the report", "nothing"])
def test_a_stop_after_more_work_is_reported_again(board, capsys, tmp_path, tools, reported):
    dispatched(board)
    log = transcript(tmp_path, tool_use("Bash"))
    hook(stop(WORKER, "修复前", log), capsys)
    with open(log, "a", encoding="utf-8") as f:
        for name in tools:
            f.write(json.dumps(tool_use(name)) + "\n")
    out = hook(stop(WORKER, "修复后测试通过", log, again=True), capsys)
    assert (out is not None) == reported
    turns = [m for k, m, _, _ in letters(board) if k == "turn"]
    assert turns[-1].endswith("修复后测试通过" if reported else "修复前")


def test_a_director_that_is_not_running_is_named_and_nothing_is_sent(board, monkeypatch, capsys):
    dispatched(board)
    live(monkeypatch, {WORKER: "p-1"})
    reason = hook(stop(WORKER, "等你定方案"), capsys)["reason"]
    assert "bbbbbbbb 现在不在运行" in reason and "letters #1" in reason
    assert "不要调 SendMessage" in reason and "<<<" not in reason
    assert letters(board) == [("turn", "[待 review] 等你定方案", WORKER, 0)]  # 留着,没丢
    assert hook(stop(WORKER, "好", again=True), capsys) is None


@pytest.mark.parametrize("says_it_waits", ["blocked", "ask"])
def test_a_worker_that_said_it_waits_is_not_sent_for_review(board, monkeypatch, says_it_waits):
    dispatched(board)
    if says_it_waits == "blocked":
        db.add_letter(board, "P-1", kind="blocked", msg="缺账号", session_id=WORKER)
    else:
        ask(board)
    assert stop_worker(board, monkeypatch, "等你定") == "等你定"


def test_waiting_is_judged_per_turn(board, monkeypatch):
    dispatched(board)
    db.add_letter(board, "P-1", kind="blocked", msg="缺账号", session_id=WORKER)
    report.post_turn(board, "P-1", "等账号", WORKER)
    db.add_letter(board, "P-1", kind="blocked", msg="别的会话报的", session_id=STRANGER)
    # 上一轮报的阻塞、别的会话报的阻塞,都不算这一轮在等人。
    assert stop_worker(board, monkeypatch).startswith("[待 review] ")


def ask(board):
    db.raise_ask(board, kind="decide", question="用 A 还是 B", evidence="两种都可行",
                 task_ids=["P-1"], raised_by="ac:x", options=["A", "B"])


@pytest.fixture
def one_second(board, monkeypatch):
    """Dispatch, then freeze the clock on the dispatch's second; returns that second."""
    dispatched(board)
    with sqlite3.connect(board) as con:
        since = con.execute("SELECT MAX(created_at) FROM task_events").fetchone()[0]
    monkeypatch.setattr(db, "_now", lambda: since)
    return since


def test_same_second_blocked_then_turn_does_not_carry_into_the_next_turn(board, one_second):
    db.add_letter(board, "P-1", kind="blocked", msg="和派发同一秒报的", session_id=WORKER)
    assert report.waiting(board, "P-1", WORKER, one_second, 0)
    report.post_turn(board, "P-1", "等账号", WORKER)
    assert not report.waiting(board, "P-1", WORKER, one_second, 0)


def test_same_second_turn_reply_then_new_ask_counts_as_waiting(board, one_second):
    report.post_turn(board, "P-1", "上一轮", WORKER)
    db.add_letter(board, "P-1", kind="reply", msg="接着干", session_id=DIRECTOR)
    ask(board)
    assert report.waiting(board, "P-1", WORKER, one_second, 0)


def test_same_second_ask_before_the_last_turn_belongs_to_that_turn(board, one_second):
    ask(board)
    report.post_turn(board, "P-1", "上一轮", WORKER)
    assert not report.waiting(board, "P-1", WORKER, one_second, 0)


def test_old_records_without_ask_numbers_fall_back_to_time(board, monkeypatch):
    dispatched(board, asks=None)
    ask(board)
    assert stop_worker(board, monkeypatch, "等你定") == "等你定"


def transcript(tmp_path, *lines) -> str:
    path = tmp_path / "t.jsonl"
    path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n",
                    encoding="utf-8")
    return str(path)


def launched(tool_use_id, result):
    return {"type": "user", "toolUseResult": result, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "content": "started"}]}}


def ended(tool_use_id):
    return {"type": "queue-operation", "content": (
        f"<task-notification>\n<task-id>x</task-id>\n<tool-use-id>{tool_use_id}</tool-use-id>\n"
        "<status>completed</status>\n</task-notification>")}


AGENT = {"isAsync": True, "status": "async_launched", "agentId": "a1"}
SHELL = {"stdout": "", "stderr": "", "backgroundTaskId": "b1"}


@pytest.mark.parametrize("lines,busy", [
    ([launched("toolu_A", AGENT)], True),
    ([launched("toolu_B", SHELL)], True),
    ([launched("toolu_A", AGENT), ended("toolu_A")], False),
    ([launched("toolu_A", AGENT), launched("toolu_B", SHELL), ended("toolu_A")], True),
    ([launched("toolu_C", {"stdout": "ok"})], False),
], ids=["sub-agent running", "shell running", "sub-agent finished", "one of two running",
        "ordinary tool"])
def test_a_worker_waiting_on_its_own_background_work_is_not_sent_for_review(
        board, monkeypatch, tmp_path, lines, busy):
    dispatched(board)
    msg = stop_worker(board, monkeypatch, "等后台 reviewer", transcript(tmp_path, *lines))
    assert msg.startswith(report.REVIEW) != busy
    assert report.background(str(tmp_path / "missing.jsonl")) is False


def test_a_delivered_report_is_marked_read(board, capsys):
    dispatched(board)
    [body] = bodies(hook(stop(WORKER), capsys)["reason"])
    assert hook(send(WORKER, "nawaban-aa", body, SENT), capsys) is None
    assert letters(board) == [("turn", "[待 review] 做完了", WORKER, 1)]


def test_an_undelivered_report_stays_unread_and_the_worker_is_told_not_to_retry(board, capsys):
    dispatched(board)
    [body] = bodies(hook(stop(WORKER), capsys)["reason"])
    out = hook(send(WORKER, "nawaban-aa", body, UNREACHABLE), capsys)
    context = out["hookSpecificOutput"]["additionalContext"]
    assert "回报没送到主控 nawaban-aa" in context and "is reachable" in context
    assert "letters #1" in context and "不要重试" in context and "别的会话" in context
    assert letters(board) == [("turn", "[待 review] 做完了", WORKER, 0)]


def bodies(reason) -> list[str]:
    return [part.split("\n>>>")[0] for part in reason.split("<<<\n")[1:]]


def test_a_report_is_confirmed_only_by_its_own_text(board, capsys):
    db.create_task(board, task_id="P-2", title="第二张卡")
    dispatched(board)
    dispatched(board, task="P-2", name="p-2")
    first, second = bodies(hook(stop(WORKER, "两张都做了"), capsys)["reason"])
    hook(send(WORKER, "nawaban-aa", first, SENT), capsys)
    hook(send(WORKER, "nawaban-aa", second, UNREACHABLE), capsys)
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT task_id, read_at IS NOT NULL FROM letters WHERE kind='turn'"
                           " ORDER BY id").fetchall() == [("P-1", 1), ("P-2", 0)]


def test_other_words_to_the_director_do_not_confirm_the_report(board, capsys):
    dispatched(board)
    hook(stop(WORKER, "做完了"), capsys)
    hook(send(WORKER, "nawaban-aa", "我自己改写的回报", SENT), capsys)
    assert letters(board) == [("turn", "[待 review] 做完了", WORKER, 0),
                              ("stage", "我自己改写的回报", WORKER, 1)]


@pytest.mark.parametrize("result,read", [(SENT, 1), (UNREACHABLE, 0)], ids=["sent", "unreachable"])
def test_a_worker_s_own_message_to_its_director_is_recorded(board, capsys, result, read):
    dispatched(board)
    out = hook(send(WORKER, "nawaban-aa", "进度:第一步做完", result), capsys)
    assert letters(board) == [("stage", "进度:第一步做完", WORKER, read)]
    if read:
        assert out is None
    else:
        context = out["hookSpecificOutput"]["additionalContext"]
        assert "话没送到主控 nawaban-aa(P-1)" in context and "letters #1" in context


def test_a_name_another_live_session_also_has_is_not_recorded(board, monkeypatch, capsys):
    dispatched(board)
    live(monkeypatch, {DIRECTOR: "nawaban-aa", WORKER: "p-1", STRANGER: "p-1"})
    assert hook(send(DIRECTOR, "p-1 [0a1b2c]", "给另一个同名会话", SENT), capsys) is None
    assert letters(board) == []


def test_a_message_the_board_cannot_record_says_so(board, monkeypatch, capsys):
    dispatched(board)

    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(report.db, "add_letter", locked)
    context = hook(send(DIRECTOR, "p-1", "用方案 B", SENT), capsys)[
        "hookSpecificOutput"]["additionalContext"]
    assert "已送达" in context and "没能记进任务库:database is locked" in context
    assert "notify P-1 --kind reply" in context


@pytest.mark.parametrize("to", ["p-1", "p-1 [35fa7a]"])
def test_a_message_to_a_worker_is_recorded_as_a_reply(board, capsys, to):
    dispatched(board)
    assert hook(send(DIRECTOR, to, "用方案 B,继续", SENT), capsys) is None
    assert letters(board) == [("reply", "用方案 B,继续", DIRECTOR, 1)]


def test_any_window_s_message_to_a_worker_is_recorded(board, capsys):
    dispatched(board)
    hook(send(STRANGER, "p-1", "重开的主控窗口回的话", SENT), capsys)
    assert letters(board) == [("reply", "重开的主控窗口回的话", STRANGER, 1)]


def test_a_reply_to_a_stopped_worker_is_kept_and_the_sender_is_told(board, capsys):
    dispatched(board)
    out = hook(send(DIRECTOR, "p-1", "用方案 B", UNREACHABLE), capsys)
    context = out["hookSpecificOutput"]["additionalContext"]
    assert "话没送到 worker p-1(P-1)" in context and "is reachable" in context
    assert "letters #1" in context and "没有送达" in context
    assert "不要用 claude --bg --resume" in context
    assert letters(board) == [("reply", "用方案 B", DIRECTOR, 0)]


def test_old_dispatch_records_without_a_name_use_the_task_id(board, capsys):
    dispatched(board, name=None)
    hook(send(DIRECTOR, "p-1", "继续", SENT), capsys)
    assert letters(board) == [("reply", "继续", DIRECTOR, 1)]


@pytest.mark.parametrize("payload", [
    send(DIRECTOR, "someone-else", "和派发无关的话", SENT),
    send(WORKER, "p-1", "worker 发给自己", SENT),
    {**send(DIRECTOR, "p-1", "x", SENT), "tool_name": "Bash"},
], ids=["other session", "worker to itself", "other tool"])
def test_messages_outside_a_dispatch_are_not_recorded(board, capsys, payload):
    dispatched(board)
    assert hook(payload, capsys) is None
    assert letters(board) == []


def test_messages_to_a_dismissed_worker_are_not_recorded(board, capsys):
    dispatched(board)
    db.add_event(board, "P-1", kind="coord", author="ac:x", body="dismiss · 已停")
    assert hook(send(DIRECTOR, "p-1", "收工后的话", SENT), capsys) is None
    assert letters(board) == []


def test_a_director_stopping_writes_and_waits_for_nothing(board, capsys):
    dispatched(board)
    db.add_letter(board, "P-1", kind="turn", msg="方案 A 还是 B?", session_id=WORKER)
    assert hook(stop(DIRECTOR, "已派出"), capsys) is None
    assert letters(board) == [("turn", "方案 A 还是 B?", WORKER, 0)]


@pytest.mark.parametrize("finish", ["done", "staging-verified", "handed_off"])
def test_the_turn_that_finishes_the_card_is_sent_once_then_stops_pass(
        board, capsys, tmp_path, finish):
    dispatched(board)
    log = transcript(tmp_path, tool_use("Bash"))
    db.claim_task(board, "P-1", owner="ac:w", session_id=WORKER)
    db.start_task(board, "P-1", owner="ac:w", session_id=WORKER, now="在做")
    if finish in ("done", "staging-verified"):
        with sqlite3.connect(board) as con:
            con.execute("UPDATE tasks SET status=? WHERE id='P-1'", (finish,))
    else:
        db.handoff(board, "P-1", owner="ac:w", session_id=WORKER, outcome=finish,
                   summary="交接", now="等评审")
    # 转 done / 交接的这一轮正是主控在等的那句话:照常拦下送一次。卡完成了就没有东西要审,
    # 不标待 review;卡没完成的交接是交付,照常标。
    out = hook(stop(WORKER, "这一轮做完了", log), capsys)
    assert out["decision"] == "block" and 'to 写 "nawaban-aa"' in out["reason"]
    review = finish == "handed_off"
    assert ("-REVIEW" in out["reason"]) is review
    said = "[待 review] 这一轮做完了" if review else "这一轮做完了"
    assert letters(board) == [("turn", said, WORKER, 0)]
    append(log, "ToolSearch", "SendMessage")
    assert hook(stop(WORKER, "已发给主控", log, again=True), capsys) is None
    for _ in range(3):  # 之后只是说句话就停:每一轮都放行,不再送,不会一轮轮被拦
        assert hook(stop(WORKER, "随口一句", log), capsys) is None
    assert [k for k, *_ in letters(board)] == ["turn"]
    assert not report._pending(WORKER).exists()


def append(log, *names):
    with open(log, "a", encoding="utf-8") as f:
        for name in names:
            f.write(json.dumps(tool_use(name)) + "\n")


@pytest.mark.parametrize("reclaim", [True, False],
                         ids=["reclaimed and handed off again", "fixed without reclaiming"])
def test_work_after_the_hand_off_report_is_reported(board, capsys, tmp_path, reclaim):
    """review 打回后改完再停:主控等的就是这一句,哪怕卡还是交接状态、最近一封信是收尾信。"""
    dispatched(board)
    log = transcript(tmp_path, tool_use("Bash"))
    db.claim_task(board, "P-1", owner="ac:w", session_id=WORKER)
    db.start_task(board, "P-1", owner="ac:w", session_id=WORKER, now="在做")
    db.handoff(board, "P-1", owner="ac:w", session_id=WORKER, outcome="handed_off",
               summary="交接", now="等评审", release=reclaim)
    assert hook(stop(WORKER, "交了", log), capsys)["decision"] == "block"
    append(log, "SendMessage")
    assert hook(stop(WORKER, "已发给主控", log, again=True), capsys) is None
    # 主控回话:review 没过。worker 在同一轮里改完(重新认领再交接,或直接改)后停下
    if reclaim:
        db.claim_task(board, "P-1", owner="ac:w", session_id=WORKER)
        db.start_task(board, "P-1", owner="ac:w", session_id=WORKER, now="改 review 意见")
        db.handoff(board, "P-1", owner="ac:w", session_id=WORKER, outcome="handed_off",
                   summary="改完再交", now="等评审", release=True)
    append(log, "Edit", "Bash")
    out = hook(stop(WORKER, "改完了,新提交 abc", log), capsys)
    assert out["decision"] == "block"
    assert [m for k, m, _, _ in letters(board) if k == "turn"][-1] == "[待 review] 改完了,新提交 abc"
    append(log, "SendMessage")
    assert hook(stop(WORKER, "已发给主控", log, again=True), capsys) is None
    assert hook(stop(WORKER, "随口一句", log), capsys) is None


def test_a_finished_worker_without_a_readable_transcript_is_still_reported(board, capsys):
    """分不清这一轮干没干活:宁可多送一封,不让主控闲住。"""
    dispatched(board)
    with sqlite3.connect(board) as con:
        con.execute("UPDATE tasks SET status='done' WHERE id='P-1'")
    assert hook(stop(WORKER, "合并了"), capsys)["decision"] == "block"
    assert hook(stop(WORKER, "已发给主控", again=True), capsys) is None
    assert hook(stop(WORKER, "又一句"), capsys)["decision"] == "block"


def test_a_worker_that_starts_again_after_handing_off_reports_again(board, capsys):
    dispatched(board)
    db.claim_task(board, "P-1", owner="ac:w", session_id=WORKER)
    db.start_task(board, "P-1", owner="ac:w", session_id=WORKER, now="在做")
    db.handoff(board, "P-1", owner="ac:w", session_id=WORKER, outcome="handed_off",
               summary="交接", now="等评审", release=True)
    db.claim_task(board, "P-1", owner="ac:w", session_id=WORKER)
    db.start_task(board, "P-1", owner="ac:w", session_id=WORKER, now="改 review 意见")
    assert hook(stop(WORKER, "改完了"), capsys)["decision"] == "block"
    assert hook(stop(WORKER, "已发给主控", again=True), capsys) is None
    with sqlite3.connect(board) as con:
        con.execute("UPDATE tasks SET status='done' WHERE id='P-1'")
    assert hook(stop(WORKER, "合并了"), capsys)["decision"] == "block"  # 再收尾,再送一次


def test_a_session_nobody_dispatched_sends_nothing(board, capsys):
    dispatched(board)
    before = list(sqlite3.connect(board).iterdump())
    assert hook(stop(STRANGER, "随便说点什么"), capsys) is None
    assert list(sqlite3.connect(board).iterdump()) == before
    assert not (Path(report.paths.state_dir()) / "report-wait").exists()


@pytest.mark.parametrize("dismissed", [True, False],
                         ids=["dismissed", "dispatched-before-directors-were-recorded"])
def test_no_live_director_means_nothing_is_sent(board, capsys, dismissed):
    dispatched(board, director=DIRECTOR if dismissed else None)
    if dismissed:
        db.add_event(board, "P-1", kind="coord", author="ac:x", body="dismiss · 已停")
    assert hook(stop(WORKER), capsys) is None
    assert letters(board) == []


def test_without_a_board_the_hook_does_nothing(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("NAWABAN_DB", str(tmp_path / "missing.db"))
    assert hook(stop(WORKER), capsys) is None
    assert hook(send(DIRECTOR, "p-1", "x", SENT), capsys) is None
    assert not (tmp_path / "missing.db").exists()


def test_long_messages_are_cut_and_say_so(board, capsys):
    dispatched(board)
    said = "头" * 1000 + "腰" * 4000 + "尾" * 500
    hook(stop(WORKER, said), capsys)
    [(kind, msg, _, _)] = letters(board)
    assert kind == "turn" and len(msg) == report.LIMIT
    assert msg.startswith(report.REVIEW + "头" * 1000) and msg.endswith("尾" * 400)
    assert "腰" not in msg
    assert "已截断:原文 5500 字,只送开头和结尾" in msg
    assert report.clip("短话") == "短话"


def test_main_survives_bad_input(monkeypatch):
    monkeypatch.setattr(sys, "stdin", __import__("io").StringIO("not json"))
    assert report.main() == 0
