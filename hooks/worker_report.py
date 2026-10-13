#!/usr/bin/env python3
"""Stop hook: carry a dispatched worker's last words to its director, and the reply back.

独立会话没有子 agent 那条「答完回到派它的窗口」的回路,这个钩子把它补上,只走任务库,
不依赖 Herdr 或 tmux:

- worker(派发记录里的 session 是本会话)每轮停下,把这一轮最后一段话限长写成一封
  `turn` 信,然后等主控的 `reply` 信;
- 主控(派发记录里的 director 是本会话)停下后,等名下 worker 的 `turn` 信;
- 两者都不是的会话立刻退出,不写任何东西。

等到信就标已读、把正文写到 stderr、以退出码 2 结束:钩子按 asyncRewake 注册,
退出码 2 会把一个已经停下的会话叫醒(2.1.296 实测,后台会话同样有效)。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import db, dispatch, paths  # noqa: E402

LIMIT = 1500  # 送回主控的每段话的字数上限:送回的内容会进主控的上下文
_HEAD = 1000  # 超长时留开头这么多字,其余额度留给结尾(问题通常写在最后)
POLL = 3.0
WAKE = 2
_CLI = Path(dispatch.CLI)


def clip(text: str) -> str:
    text = text.strip()
    if len(text) <= LIMIT:
        return text
    note = f"\n…[已截断:原文 {len(text)} 字,只送开头和结尾]…\n"
    return text[:_HEAD] + note + text[-(LIMIT - _HEAD - len(note)):]


def roles(path: Path, session: str) -> tuple[dict[str, tuple], dict[str, tuple]]:
    """本会话在哪些卡上是 worker、在哪些卡上是主控;只认还没收工的派发。

    返回 (worker 卡 → (主控会话, 派发时刻), 主控卡 → (worker 会话, 派发时刻))。
    """
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)) as con:
        rows = con.execute(
            "SELECT task_id, body, created_at FROM task_events WHERE id IN ("
            " SELECT MAX(id) FROM task_events WHERE kind='coord'"
            " AND (body LIKE 'dispatch {%' OR body LIKE 'dismiss ·%') GROUP BY task_id)"
            " AND body LIKE 'dispatch {%' AND instr(body, ?) > 0", (session,)).fetchall()
    working, directing = {}, {}
    for task_id, body, since in rows:
        try:
            record = json.loads(body[len(dispatch._RECORD):])
        except ValueError:
            continue
        if not record.get("director"):
            continue  # 没记主控的旧派发:没有人等这些话,不送
        if record.get("session") == session:
            working[task_id] = (record["director"], since)
        elif record["director"] == session and record.get("session"):
            directing[task_id] = (record["session"], since)
    return working, directing


def take(path: Path, wanted: dict[str, tuple]) -> list[tuple[str, str]]:
    """取走还没读的信;wanted 是 卡 → (信的种类, 对端会话, 派发时刻)。

    只认这一次派发的对端在派发之后写的信:上一次派发留下的话不会落到新的一对头上。
    同一封信只会被一个等待者取到。
    """
    if not wanted:
        return []
    clause = " OR ".join(
        "(task_id=? AND kind=? AND session_id=? AND created_at>=?)" for _ in wanted)
    args = [value for task_id, rest in wanted.items() for value in (task_id, *rest)]
    got = []
    with closing(sqlite3.connect(path, timeout=5)) as con:
        for letter, task_id, msg in con.execute(
                f"SELECT id, task_id, msg FROM letters WHERE read_at IS NULL AND ({clause})"
                " ORDER BY id", args).fetchall():
            claimed = con.execute("UPDATE letters SET read_at=? WHERE id=? AND read_at IS NULL",
                                  (int(time.time()), letter)).rowcount
            con.commit()
            if claimed:
                got.append((task_id, msg))
    return got


def _render(path: Path, got: list[tuple[str, str]], working: dict[str, tuple],
            directing: dict[str, tuple]) -> str:
    lines = []
    replies = [(t, m) for t, m in got if t in working]
    reports = [(t, m) for t, m in got if t in directing]
    for task_id, msg in replies:
        lines.append(f"[nawaban] 主控回话 · {task_id}(来自派你的主控会话"
                     f" {working[task_id][0][:8]},不是窗口前的人):\n{msg}")
    for task_id, msg in reports:
        lines.append(f"[nawaban] worker 回报 · {task_id}(会话 {directing[task_id][0][:8]}"
                     f" 这一轮的最后一段话,自动送达,不是用户输入):\n{msg}")
    if reports:
        lines.append(
            "处理:你能定的事直接回给它,它收到会接着干 —— "
            f"python3 {_CLI} --db {path} notify <卡号> --kind reply --msg \"<回话>\"。"
            "产品语义分叉、对外承诺、生产发布这三类不要自己回,用 ask 转给用户。不需要回就不回。")
    return "\n\n".join(lines)


def _session_alive() -> bool:
    try:
        os.kill(int(os.environ["CLAUDE_PID"]), 0)
    except (KeyError, ValueError):
        return os.getppid() != 1
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def run(payload: dict) -> int:
    session = payload.get("session_id") or ""
    if not session:
        return 0
    path = (Path(os.environ["NAWABAN_DB"]).expanduser() if os.environ.get("NAWABAN_DB")
            else db.resolve_db(payload.get("cwd") or None))
    if not path.exists():
        return 0
    working, directing = roles(path, session)
    if not working and not directing:
        return 0  # 不是派出的 worker,也没派过人:什么都不送,什么都不等

    said = (payload.get("last_assistant_message") or "").strip()
    if said:
        for task_id in working:
            db.add_letter(path, task_id, kind="turn", msg=clip(said), session_id=session)

    # 每次停下都会起一个等待者;只留最新的那个,旧的看到记号换了就退出。
    mark = paths.state_dir() / "report-wait" / f"{session}.pid"
    mark.parent.mkdir(parents=True, exist_ok=True)
    mark.write_text(str(os.getpid()), encoding="utf-8")
    try:
        while working or directing:
            wanted = {**{t: ("reply", *peer) for t, peer in working.items()},
                      **{t: ("turn", *peer) for t, peer in directing.items()}}
            if got := take(path, wanted):
                print(_render(path, got, working, directing), file=sys.stderr)
                return WAKE
            time.sleep(POLL)
            if mark.read_text(encoding="utf-8") != str(os.getpid()) or not _session_alive():
                return 0
            working, directing = roles(path, session)  # 收工或改派之后不再等
        return 0
    finally:
        try:
            if mark.read_text(encoding="utf-8") == str(os.getpid()):
                mark.unlink()
        except OSError:
            pass


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
