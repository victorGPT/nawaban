#!/usr/bin/env python3
"""Stop hook: carry a dispatched worker's last words to its director, and the reply back.

独立会话没有子 agent 那条「答完回到派它的窗口」的回路,这个钩子把它补上,只走任务库,
不依赖 Herdr 或 tmux:

- worker(派发记录里的 session 是本会话)每轮停下,把这一轮最后一段话限长写成一封
  `turn` 信,然后等主控的 `reply` 信。这一轮没报阻塞、没提 ask、也没有自己的后台任务
  在跑,停下就是交付:信前标上「待 review」,主控不用等 worker 自己报 done 就去 review;
- 主控(派发记录里的 director 是本会话)停下后,等名下 worker 的 `turn` 信;
- 两者都不是的会话立刻退出,不写任何东西。

等到信就标已读、把正文写到 stderr、以退出码 2 结束:钩子按 asyncRewake 注册,
退出码 2 会把一个已经停下的会话叫醒(2.1.296 实测,后台会话同样有效)。
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import time
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import db, dispatch, paths  # noqa: E402

LIMIT = 1500  # 送回主控的每段话的字数上限:送回的内容会进主控的上下文
_HEAD = 1000  # 超长时留开头这么多字,其余额度留给结尾(问题通常写在最后)
REVIEW = "[待 review] "
POLL = 3.0
WAKE = 2
_CLI = Path(dispatch.CLI)


def clip(text: str, room: int = LIMIT) -> str:
    text = text.strip()
    if len(text) <= room:
        return text
    note = f"\n…[已截断:原文 {len(text)} 字,只送开头和结尾]…\n"
    return text[:_HEAD] + note + text[-(room - _HEAD - len(note)):]


def roles(path: Path, session: str) -> tuple[dict[str, tuple], dict[str, tuple]]:
    """本会话在哪些卡上是 worker、在哪些卡上是主控;只认还没收工的派发。

    返回 (worker 卡 → (主控会话, 派发时刻, 派发时最大的 ask 编号), 主控卡 → (worker 会话, 派发时刻))。
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
            working[task_id] = (record["director"], since, record.get("asks"))
        elif record["director"] == session and record.get("session"):
            directing[task_id] = (record["session"], since)
    return working, directing


def _asks_mark(provenance: str | None) -> int | None:
    try:
        return int(json.loads(provenance)["asks"])
    except (TypeError, ValueError, KeyError):
        return None


def post_turn(path: Path, task_id: str, msg: str, session: str) -> None:
    """写一封 turn 信,并记下此刻最大的 ask 编号:下一轮凭它分清哪些 ask 是之后提的。

    worker 已经停下,记编号和写信之间它提不了新的 ask。
    """
    with closing(sqlite3.connect(path, timeout=5)) as con:
        mark = con.execute("SELECT COALESCE(MAX(id), 0) FROM asks").fetchone()[0]
    letter = db.add_letter(path, task_id, kind="turn", msg=msg, session_id=session)
    with closing(sqlite3.connect(path, timeout=5)) as con, con:
        con.execute("UPDATE letters SET provenance=? WHERE id=?",
                    (json.dumps({"asks": mark}), letter))


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


def take(path: Path, wanted: dict[str, tuple]) -> list[tuple[str, str]]:
    """取走还没读的信;wanted 是 卡 → (信的种类, 对端会话, 派发时刻)。

    只认这一次派发的对端在派发之后写的信:上一次派发留下的话不会落到新的一对头上。
    同一封信只会被一个等待者取到。
    """
    if not wanted:
        return []
    clause = " OR ".join(
        "(task_id=? AND kind=? AND session_id=? AND created_at>?)" for _ in wanted)
    args = [value for task_id, rest in wanted.items() for value in (task_id, *rest)]
    got = []
    with closing(sqlite3.connect(path, timeout=5)) as con:
        for letter, task_id, msg in con.execute(
                f"SELECT id, task_id, msg FROM letters WHERE read_at IS NULL AND ({clause})"
                " ORDER BY id", args).fetchall():
            # 取信和「派发还有效」在同一条语句里判:收工之后到的信不取。
            claimed = con.execute(
                "UPDATE letters SET read_at=? WHERE id=? AND read_at IS NULL AND ("
                " SELECT body FROM task_events WHERE task_id=letters.task_id AND kind='coord'"
                " AND (body LIKE 'dispatch {%' OR body LIKE 'dismiss ·%')"
                " ORDER BY id DESC LIMIT 1) LIKE 'dispatch {%'",
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
    if any(msg.startswith(REVIEW) for _, msg in reports):
        lines.append(
            f"{REVIEW.strip()}:worker 这一轮停下、没报阻塞、没提 ask、也没有后台任务在跑,按协议就是交付了,不用等它报 done。"
            f"主控不审也不合:建 <卡号>-REVIEW 卡并 python3 {_CLI} --db {path} dispatch 它,"
            "派一个 review worker 去审(已有 review worker 就回话让它审新提交);"
            "做法见 nawaban-director skill 的 Review and merging 一节。卡要 done 仍然要 merge_sha。")
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
        busy = background(payload.get("transcript_path"))
        for task_id, (_, since, asks) in working.items():
            msg = (clip(said) if busy or waiting(path, task_id, session, since, asks)
                   else REVIEW + clip(said, LIMIT - len(REVIEW)))
            post_turn(path, task_id, msg, session)

    # 每次停下都会起一个等待者;只留最新的那个,旧的看到记号换了就退出。
    mark = paths.state_dir() / "report-wait" / f"{session}.pid"
    mark.parent.mkdir(parents=True, exist_ok=True)
    mark.write_text(str(os.getpid()), encoding="utf-8")
    try:
        while working or directing:
            wanted = {**{t: ("reply", *peer[:2]) for t, peer in working.items()},
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
