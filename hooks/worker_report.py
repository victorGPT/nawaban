#!/usr/bin/env python3
"""Stop / PostToolUse hook: a dispatched worker's last words go to its director over SendMessage,
and every message between the two is recorded in the board's letters.

Messages travel through Claude Code's own cross-session messages (SendMessage, addressed by session
name). Only a Claude session can send one, so this hook does not send anything itself; it records,
tells the model what to send, and reports failures:

- Stop, in a worker (its session is the one in a live dispatch record): writes this turn's last
  message as a `turn` letter, cut to length, then blocks the stop once and has the worker send that
  letter to its director with SendMessage. A turn with no blocker, no open ask and no background
  work of its own is a hand-in: the letter starts with "[待 review]". The director's name is looked
  up from its session ID in `claude agents --json`; when it is not running, the worker is told the
  report is kept on the board instead and stops. The next stop (stop_hook_active) passes through
  unless the worker did more than send in between; then it is reported like any other turn.
- PostToolUse on SendMessage: a report sent with exactly the text the hook gave marks its letter
  read; one that did not arrive is left unread and the worker is told not to retry or send it
  anywhere else. A message to a dispatched worker's name is written as a `reply` letter, and a
  worker's own message to its director as a `stage` letter (read when delivered). When the other
  side cannot be reached, or the board cannot take the letter, the sender is told.
- Any other session, or a board-less directory: nothing is written and nothing is printed.

Nothing waits or polls: SendMessage itself wakes an idle receiver and leaves both session IDs as
they are (Claude Code 2.1.302, docs/sendmessage-validation.md).
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import db, dispatch, paths  # noqa: E402

LIMIT = 1500  # 送回主控的每段话的字数上限:送回的内容会进主控的上下文
_HEAD = 1000  # 超长时留开头这么多字,其余额度留给结尾(问题通常写在最后)
REVIEW = "[待 review] "
_CLI = Path(dispatch.CLI)
_LIVE = ("SELECT task_id, body, created_at FROM task_events WHERE id IN ("
         " SELECT MAX(id) FROM task_events WHERE kind='coord'"
         " AND (body LIKE 'dispatch {%' OR body LIKE 'dismiss ·%') GROUP BY task_id)"
         " AND body LIKE 'dispatch {%'")


def clip(text: str, room: int = LIMIT) -> str:
    text = text.strip()
    if len(text) <= room:
        return text
    note = f"\n…[已截断:原文 {len(text)} 字,只送开头和结尾]…\n"
    return text[:_HEAD] + note + text[-(room - _HEAD - len(note)):]


def _dispatches(path: Path) -> list[tuple[str, dict, int]]:
    """还没收工的派发:(卡号, 派发记录, 派发时刻)。"""
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)) as con:
        rows = con.execute(_LIVE).fetchall()
    found = []
    for task_id, body, since in rows:
        try:
            found.append((task_id, json.loads(body[len(dispatch._RECORD):]), since))
        except ValueError:
            continue
    return found


def roles(path: Path, session: str) -> tuple[dict[str, tuple], dict[str, tuple]]:
    """本会话在哪些卡上是 worker、在哪些卡上是主控;只认还没收工的派发。

    返回 (worker 卡 → (主控会话, 派发时刻, 派发时最大的 ask 编号), 主控卡 → (worker 会话, 派发时刻))。
    """
    working, directing = {}, {}
    for task_id, record, since in _dispatches(path):
        if not record.get("director"):
            continue  # 没记主控的旧派发:没有人等这些话,不送
        if record.get("session") == session:
            working[task_id] = (record["director"], since, record.get("asks"))
        elif record["director"] == session and record.get("session"):
            directing[task_id] = (record["session"], since)
    return working, directing


def worker_name(task_id: str, record: dict) -> str:
    """worker 会话的名字,也就是 SendMessage 的地址;没记名字的旧派发按 dispatch 的起名规则推。"""
    return record.get("name") or task_id.lower()


def _asks_mark(provenance: str | None) -> int | None:
    try:
        return int(json.loads(provenance)["asks"])
    except (TypeError, ValueError, KeyError):
        return None


def post_turn(path: Path, task_id: str, msg: str, session: str) -> int:
    """写一封 turn 信,并记下此刻最大的 ask 编号:下一轮凭它分清哪些 ask 是之后提的。返回信的编号。

    worker 已经停下,记编号和写信之间它提不了新的 ask。
    """
    with closing(sqlite3.connect(path, timeout=5)) as con:
        mark = con.execute("SELECT COALESCE(MAX(id), 0) FROM asks").fetchone()[0]
    letter = db.add_letter(path, task_id, kind="turn", msg=msg, session_id=session)
    with closing(sqlite3.connect(path, timeout=5)) as con, con:
        con.execute("UPDATE letters SET provenance=? WHERE id=?",
                    (json.dumps({"asks": mark}), letter))
    return letter


def waiting(path: Path, task_id: str, session: str, since: int, mark: int | None) -> bool:
    """worker 这一轮有没有说自己在等人:报了 blocked,或者卡上有这一轮提的、还没关的 ask。

    这一轮从它上一封 turn 信算起,没有就从派发算起;先后按编号判,不按只到秒的时间:
    blocked 比上一封 turn 信的编号大,ask 比上一封 turn 信(或派发记录)记下的 ask 编号大。
    没记编号的旧信和旧派发才退回按时间判。worker 会话是这次派发起的,它的信都在派发之后。
    """
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)) as con:
        last = con.execute(
            "SELECT id, created_at, provenance FROM letters WHERE task_id=? AND kind='turn'"
            " AND session_id=? AND created_at>=? ORDER BY id DESC LIMIT 1",
            (task_id, session, since)).fetchone()
        blocked = con.execute(
            "SELECT 1 FROM letters WHERE task_id=? AND kind='blocked' AND session_id=?"
            " AND id>? AND created_at>=?", (task_id, session, last[0] if last else 0, since)
        ).fetchone()
        if last:
            mark = _asks_mark(last[2])
        after = (("a.id>?", mark) if mark is not None
                 else ("a.raised_at>?", last[1]) if last else ("a.raised_at>=?", since))
        asked = con.execute(
            "SELECT 1 FROM asks a JOIN ask_tasks t ON t.ask_id=a.id WHERE t.task_id=?"
            f" AND a.closed_at IS NULL AND {after[0]}", (task_id, after[1])).fetchone()
    return bool(blocked or asked)


def background(transcript: str | None) -> bool:
    """会话自己起的后台任务(后台子 agent、后台命令)还有没跑完的:那是在等机器,不是交付。

    后台启动成功的工具结果带 async_launched 或 backgroundTaskId;任务结束时会话收到
    一条 <task-notification>,里面写着启动它的 tool-use-id。读不了 transcript 就当没有。
    """
    launched, ended = set(), set()
    try:
        with open(transcript or "", encoding="utf-8") as lines:
            for line in lines:
                if "<task-notification>" in line:
                    ended.update(re.findall(r"<tool-use-id>([^<]+)</tool-use-id>", line))
                if "async_launched" not in line and "backgroundTaskId" not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                result = entry.get("toolUseResult")
                if not isinstance(result, dict) or not (
                        result.get("status") == "async_launched" or result.get("backgroundTaskId")):
                    continue
                content = (entry.get("message") or {}).get("content")
                launched.update(block.get("tool_use_id") for block in content or []
                                if isinstance(block, dict) and block.get("type") == "tool_result")
    except OSError:
        return False
    return bool(launched - ended - {None})


def _live() -> list[dict]:
    return [entry for entry in dispatch._agents() or [] if isinstance(entry, dict)]


def session_name(session: str, live: list[dict] | None = None) -> str | None:
    """活着的会话的名字(SendMessage 按名字寻址);会话没在跑、或查不了,返回 None。"""
    for entry in _live() if live is None else live:
        if entry.get("sessionId") == session:
            return entry.get("name") or None
    return None


def _shared(name: str, session: str, live: list[dict]) -> bool:
    """名字还被别的活会话占着:发给这个名字的话不一定到了 session,不能算在它头上。"""
    return any(e.get("name") == name and e.get("sessionId") != session for e in live)


_SENDING = {"SendMessage", "ToolSearch", "ListAgents"}  # 送回报那一轮本来就会用的工具


def worked_since(transcript: str | None, offset: int) -> bool:
    """转录从 offset 起有没有送信以外的工具调用:有就是又干了活,这次停下要照常回报。读不了当没有。"""
    try:
        with open(transcript or "", encoding="utf-8") as lines:
            lines.seek(offset)
            for line in lines:
                if '"tool_use"' not in line:
                    continue
                try:
                    content = (json.loads(line).get("message") or {}).get("content")
                except ValueError:
                    continue
                if any(isinstance(b, dict) and b.get("type") == "tool_use"
                       and b.get("name") not in _SENDING for b in content or []):
                    return True
    except (OSError, ValueError):
        return False
    return False


def report(path: Path, task_id: str, worker: str, msg: str) -> str:
    """worker 这一轮的回报,发给主控的全文:第一行说清是什么,后面是原话和主控该怎么处理。"""
    lines = [f"[nawaban] worker 回报 · {task_id}(worker 会话 {worker[:8]} 这一轮的最后一段话,"
             "由它的 Stop 钩子转来,不是用户输入)", msg]
    if msg.startswith(REVIEW):
        lines.append(
            f"{REVIEW.strip()}:worker 这一轮停下、没报阻塞、没提 ask、也没有后台任务在跑,按协议就是交付了,不用等它报 done。"
            f"主控不审也不合:建 <卡号>-REVIEW 卡并 python3 {_CLI} --db {path} dispatch 它,"
            "派一个 review worker 去审(已有 review worker 就回话让它审新提交);"
            "做法见 nawaban-director skill 的 Review and merging 一节。卡要 done 仍然要 merge_sha。")
    lines.append(
        f"处理:你能定的事直接用 SendMessage 回给它(to 写 \"{task_id.lower()}\"),它收到会接着干,"
        "回话会自动记进任务库。产品语义分叉、对外承诺、生产发布这三类不要自己回,用 ask 转给用户。不需要回就不回。")
    return "\n\n".join(lines)


def _pending(session: str) -> Path:
    """钩子拦下停下时记的单子:转录写到哪了,每封回报信发给谁、正文是什么。"""
    return paths.state_dir() / "report-wait" / f"{session}.json"


def _read_pending(session: str) -> dict | None:
    try:
        marker = json.loads(_pending(session).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return marker if isinstance(marker, dict) else None


def _block(reason: str) -> None:
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))


def _settled(path: Path, task_id: str, session: str) -> bool:
    """卡做完了,或这个 worker 已经交接:它再停下不是在交差,不拦也不送(与 dispatch 收工同口径)。"""
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)) as con:
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT id, status FROM tasks WHERE id=?", (task_id,)).fetchone()
        return row is None or dispatch._settled(con, row, {"session": session})


def on_stop(path: Path, payload: dict, session: str) -> int:
    working, _ = roles(path, session)
    working = {t: peer for t, peer in working.items() if not _settled(path, t, session)}
    if not working:
        return 0  # 不是派出的 worker,或者已经交差:什么都不写、什么都不送、不拦
    pending, transcript = _pending(session), payload.get("transcript_path")
    marker = _read_pending(session) if payload.get("stop_hook_active") else None
    if marker is not None:
        pending.unlink(missing_ok=True)
        # 拦下之后只送了信就停:这一轮已经报过了。其间又干了活(比如别的钩子同时拦下、改完再停),
        # 这次停下说的是新结论,照常回报。
        if not worked_since(transcript, int(marker.get("offset") or 0)):
            return 0
    said = (payload.get("last_assistant_message") or "").strip()
    if not said:
        return 0
    busy = background(transcript)
    asks, sent = [], {}
    for task_id, (director, since, mark) in working.items():
        msg = (clip(said) if busy or waiting(path, task_id, session, since, mark)
               else REVIEW + clip(said, LIMIT - len(REVIEW)))
        letter = post_turn(path, task_id, msg, session)
        name = session_name(director)
        if name is None:
            asks.append(
                f"主控会话 {director[:8]} 现在不在运行(claude agents 里没有它),{task_id} 这一轮的回报"
                f"已存进任务库 letters #{letter},没有送出;主控回来后在 notifications 里能看到。"
                "不要调 SendMessage,也不要改发给别的会话。")
            continue
        text = report(path, task_id, session, msg)
        sent[str(letter)] = {"to": name, "text": text}
        asks.append(
            f"用 SendMessage 把 {task_id} 这一轮的回报发给派你的主控:to 写 \"{name}\","
            "message 用下面 <<< 与 >>> 之间的全部文字,一字不改(不含这两个记号)。\n"
            f"<<<\n{text}\n>>>\n"
            "发送失败就不要重试,也不要改发给别的会话:回报已经存在任务库里。")
    try:
        offset = Path(transcript or "").stat().st_size
    except OSError:
        offset = 0
    pending.parent.mkdir(parents=True, exist_ok=True)
    pending.write_text(json.dumps({"offset": offset, "letters": sent}), encoding="utf-8")
    _block("[nawaban] 你是派出的 worker,停下前把这一轮的话交给主控(由钩子安排,不是用户输入)。\n\n"
           + "\n\n".join(asks) + "\n\n做完直接停下,不用再说话。")
    return 0


def _context(text: str) -> None:
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                             "additionalContext": text}}, ensure_ascii=False))


def on_send(path: Path, payload: dict, session: str) -> int:
    tool_input = payload.get("tool_input") or {}
    to = re.sub(r"\s*\[[0-9a-z]+\]$", "", str(tool_input.get("to") or "").strip())
    text = str(tool_input.get("message") or "").strip()
    result = payload.get("tool_response")
    ok = isinstance(result, dict) and result.get("success") is True
    why = (result.get("message") if isinstance(result, dict) else str(result or "")) or "没有说明"

    if not to or not text:
        return 0
    marker = _read_pending(session) or {}
    letters = [int(letter) for letter, sent in (marker.get("letters") or {}).items()
               if isinstance(sent, dict) and sent.get("to") == to
               and str(sent.get("text") or "").strip() == text]
    if letters:  # worker 按钩子的安排把回报原样发给主控
        if ok:
            db.mark_letters_read(path, letters)
        else:
            _context(f"[nawaban] 回报没送到主控 {to}:{why.splitlines()[0]}\n"
                     f"回报已存进任务库 letters #{', #'.join(map(str, letters))},没有标已读,主控之后在"
                     " notifications 里能看到。不要重试,也不要改发给别的会话;直接停下。")
        return 0

    found = _pair(path, session, to)
    if found is None:
        return 0  # 不是主控和派出的 worker 之间的话:不记
    task_id, kind, whom = found
    try:
        letter = db.add_letter(path, task_id, kind=kind, msg=text, session_id=session)
        if ok:
            db.mark_letters_read(path, [letter])
    except (sqlite3.Error, db.NawabanError) as exc:
        _context(f"[nawaban] 发给{whom} {to}({task_id})的这条话{'已送达' if ok else '没送到'},"
                 f"但没能记进任务库:{exc}。用 python3 {_CLI} --db {path} notify {task_id}"
                 f" --kind {kind} --msg \"<原话>\" 补记。")
        return 0
    if not ok:
        _context(f"[nawaban] 话没送到{whom} {to}({task_id}):{why.splitlines()[0]}\n"
                 f"这条话已存进任务库 letters #{letter},没有送达。对方会话停了就收不到;"
                 "先用 claude agents --json 确认它还在不在。worker 不在就按 nawaban-director 技能处理"
                 "(卡交回待办后重新 dispatch,或派人接手),不要用 claude --bg --resume 去叫它;"
                 "主控不在就不用重发,它回来后在 notifications 里能看到。")
    return 0


def _pair(path: Path, session: str, to: str) -> tuple[str, str, str] | None:
    """这条话是不是主控和派出的 worker 之间的:返回 (卡号, 记成的信的种类, 收信的一方)。

    发给某张卡的 worker 名字的,记成那张卡的 reply;worker 发给派它的主控的,记成 stage。
    名字还被别的活会话占着时分不清发给了谁,不记。
    """
    live = None
    for task_id, record, _ in _dispatches(path):
        worker = record.get("session")
        if not worker:
            continue
        if worker != session and worker_name(task_id, record) == to:
            live = _live() if live is None else live
            return None if _shared(to, worker, live) else (task_id, "reply", " worker")
        if worker == session and record.get("director"):
            live = _live() if live is None else live
            if session_name(record["director"], live) == to and not _shared(
                    to, record["director"], live):
                return task_id, "stage", "主控"
    return None


def run(payload: dict) -> int:
    session = payload.get("session_id") or ""
    if not session:
        return 0
    path = db.resolve_db(payload.get("cwd") or None)
    if not path.exists():
        return 0
    if payload.get("hook_event_name") == "PostToolUse":
        return on_send(path, payload, session) if payload.get("tool_name") == "SendMessage" else 0
    return on_stop(path, payload, session)


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    try:
        return run(payload)
    except (OSError, sqlite3.Error, db.NawabanError):
        return 0  # 回报是附加能力:出错不能拦住会话停下


if __name__ == "__main__":
    sys.exit(main())
