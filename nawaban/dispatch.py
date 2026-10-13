"""Dispatch one card to one independent worker session, and tear that session down.

dispatch 只起会话并把会话编号写到卡的当前进展;认领由 worker 进场后自己做,
这样 task_sessions 记的是 worker 的会话。派发记录是一条 coord 事件(正文 JSON),
dismiss 凭它找回会话、窗格和工位。
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import time
from contextlib import closing
from pathlib import Path

from nawaban import db

RUN = subprocess.run  # 测试在这里换成替身,不真起会话
CLI = Path(__file__).resolve().parent / "cli.py"
_RECORD = "dispatch "
_FINISHED = ("staging-verified", "done", "cancelled")


def _run(*cmd: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    try:
        return RUN(list(cmd), cwd=cwd, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(list(cmd), 127, "", str(exc))


def _connect(path: Path) -> sqlite3.Connection:
    con = db.connect(path)
    con.row_factory = sqlite3.Row
    return con


def _row(con: sqlite3.Connection, task_id: str) -> sqlite3.Row:
    row = con.execute("SELECT id,status,owner,project FROM tasks WHERE id=?",
                      (task_id,)).fetchone()
    if row is None:
        raise db.NawabanError(f"卡不存在:{task_id}")
    return row


def _blocker(con: sqlite3.Connection, row: sqlite3.Row) -> str | None:
    """为什么这张卡现在不能派;能派返回 None。前置卡判定与 claim 上游闸同一口径。"""
    if row["status"] in ("claimed", "in_progress"):
        return f"已被 {row['owner']} 认领"
    if row["status"] != "open":
        return f"不是待办状态(当前 {row['status']})"
    upstream = con.execute(
        "SELECT e.dst, t.status FROM task_edges e JOIN tasks t ON t.id=e.dst"
        " WHERE e.src=? AND e.kind='depends_on' AND t.status NOT IN ('done','cancelled')"
        " ORDER BY e.dst", (row["id"],)).fetchall()
    if upstream:
        return "前置卡未完成:" + "、".join(f"{u[0]}({u[1]})" for u in upstream)
    return None


def _repo_root() -> Path:
    found = _run("git", "rev-parse", "--path-format=absolute", "--git-common-dir")
    if found.returncode:
        raise db.NawabanError("派发要在目标仓库里执行:当前目录不是 git 仓库")
    return Path(found.stdout.strip()).parent


def _session(name: str, *, tries: int = 1) -> dict | None:
    """按名字在活着的会话里找;刚起的会话登记有延迟,所以可以多看几次。"""
    for attempt in range(tries):
        if attempt:
            time.sleep(1)
        try:
            listed = json.loads(_run("claude", "agents", "--json").stdout or "[]")
        except ValueError:
            listed = []
        for entry in listed:
            if entry.get("name") == name:
                return entry
    return None


def _trusted(root: Path) -> bool:
    """只用来决定走不走 Herdr:没信任的目录在窗格里会停在信任提示上。

    读不到就当没信任,改走后台会话;拒绝与否由 `claude --bg` 自己说了算。
    """
    try:
        projects = json.loads((Path.home() / ".claude.json").read_text(encoding="utf-8"))["projects"]
        return bool(projects[str(root)]["hasTrustDialogAccepted"])
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _session_args(name: str) -> list[str]:
    return ["-w", name, "--name", name, "--permission-mode", "auto"]


def _herdr(root: Path, name: str, prompt: str) -> str | None:
    """在新窗格里起 worker,返回窗格号;任何一步失败都关掉窗格并返回 None。"""
    split = _run("herdr", "pane", "split", "--direction", "right",
                 "--cwd", str(root), "--no-focus")
    try:
        pane = json.loads(split.stdout)["result"]["pane"]["pane_id"]
    except (ValueError, KeyError, TypeError):
        return None
    if split.returncode:
        return None
    for cmd in (("herdr", "agent", "start", name, "--kind", "claude", "--pane", pane,
                 "--", *_session_args(name)),
                ("herdr", "agent", "prompt", name, prompt)):
        if _run(*cmd).returncode:
            _run("herdr", "pane", "close", pane)
            return None
    return pane


def brief(path: Path, task_id: str, name: str) -> str:
    from nawaban import context_loader  # 它依赖 web 模块;CLI 其余动词没有 web 也要能跑
    nawaban = f"python3 {CLI} --db {path}"
    return f"""你是被派出的 worker,只做一张卡:{task_id}。
开工:先加载 nawaban:nawaban 技能,按它认领这张卡再 start。任务库是 {path},命令写成 {nawaban} <动词>。
你所在的目录已经是这张卡的独立工位(分支 worktree-{name}),直接在这里改;不要再建工位,不要改主树。
范围:只做这张卡的验收条目。不建新卡,不起别的 worker,不动别的卡,不合并。
没有人坐在这个窗口前。实现选型、命名、测试写法自己定;确实定不了的,用 {nawaban} notify {task_id} --kind blocked --msg "问题和你的建议" 写到看板上然后停下。做完用 notify --kind done 汇报,附 PR 链接和测试结果。

{context_loader.build_context(path, task_id)}"""


def dispatch(path: Path, task_id: str, *, author: str) -> str:
    """为一张待办卡起一个 worker 会话;不能派就抛出一句原因。返回会话编号。"""
    with closing(_connect(path)) as con:
        row = _row(con, task_id)
        reason = _blocker(con, row)
    if reason:
        raise db.NawabanError(f"不派 {task_id}:{reason}")
    root = _repo_root()
    if row["project"] and row["project"] != root.name:
        raise db.NawabanError(
            f"不派 {task_id}:它属于项目 {row['project']},当前仓库是 {root.name}")
    name = task_id.lower()
    if _session(name):
        raise db.NawabanError(f"不派 {task_id}:已经有一个叫 {name} 的会话在跑")
    prompt = brief(path, task_id, name)

    pane, output = None, ""
    if os.environ.get("HERDR_ENV") == "1" and _trusted(root):
        pane = _herdr(root, name, prompt)
        if pane is None and _session(name):
            # 窗格没关掉、里面的会话还活着:再起后台会话就是两个 worker 做同一张卡。
            raise db.NawabanError(
                f"不派 {task_id}:Herdr 里的会话 {name} 起了一半没能关掉,请先手工关掉那个窗格")
    if pane is None:
        started = _run("claude", "--bg", *_session_args(name), prompt, cwd=root)
        if started.returncode:
            detail = (started.stderr or started.stdout).strip().splitlines()
            raise db.NawabanError(
                f"不派 {task_id}:会话没起来 —— {detail[0] if detail else '没有输出'}")
        output = started.stdout.strip()

    live = _session(name, tries=5) or {}
    session = live.get("sessionId") or "未查到"
    worktree = live.get("cwd") or str(root / ".claude" / "worktrees" / name)
    record = {"backend": "herdr" if pane else "claude-bg", "session": live.get("sessionId"),
              "pane": pane, "worktree": worktree, "root": str(root)}
    where = f"窗格 {pane}" if pane else "后台"
    try:
        db.add_event(path, task_id, kind="coord", author=author,
                     body=_RECORD + json.dumps(record, ensure_ascii=False),
                     now=f"已派发({where})· 会话 {session} · 工位 {Path(worktree).name}"[:200])
    except (sqlite3.Error, db.NawabanError) as exc:
        # 记不进卡的 worker 没人能找到、没人能收工,所以停掉它。
        _stop(record)
        raise db.NawabanError(f"不派 {task_id}:会话起了但记不进卡,已停掉 —— {exc}") from exc
    if not record["session"]:
        raise db.NawabanError(
            f"{task_id} 的会话已经起了,但没查到它的编号;用 claude agents 确认后手工处理"
            + (f"(启动输出:{output[:200]})" if output else ""))
    return session


def _stop(record: dict) -> subprocess.CompletedProcess | None:
    if record["pane"]:
        return _run("herdr", "pane", "close", record["pane"])
    if record["session"]:
        return _run("claude", "stop", record["session"][:8])
    return None


def batch(path: Path, parent: str, *, author: str, dry_run: bool) -> list[str]:
    """按拆卡关系列出父卡的每张子卡:派出的、会派出的、因为什么不派的。"""
    with closing(_connect(path)) as con:
        _row(con, parent)
        children = [(row, _blocker(con, row)) for row in con.execute(
            "SELECT t.id,t.status,t.owner,t.project FROM task_edges e JOIN tasks t ON t.id=e.src"
            " WHERE e.dst=? AND e.kind='split_from' ORDER BY t.id", (parent,))]
    if not children:
        return [f"{parent} 没有拆出的子卡"]
    lines = []
    for row, reason in children:
        head = f"{row['id']} [{row['status']}] "
        if reason:
            lines.append(head + f"不派:{reason}")
        elif dry_run:
            lines.append(head + "会派出")
        else:
            try:
                lines.append(head + f"已派出 · 会话 {dispatch(path, row['id'], author=author)}")
            except db.NawabanError as exc:
                lines.append(head + str(exc))
    return lines


def dismiss(path: Path, task_id: str, *, author: str) -> list[str]:
    """收工:停会话或关窗格,工位干净才清理。返回逐项结果。"""
    with closing(_connect(path)) as con:
        row = _row(con, task_id)
        leg = con.execute(
            "SELECT ended_at,outcome FROM task_sessions WHERE task_id=?"
            " ORDER BY started_at DESC, rowid DESC LIMIT 1", (task_id,)).fetchone()
        event = con.execute(
            "SELECT body FROM task_events WHERE task_id=? AND kind='coord' AND body LIKE ?"
            " ORDER BY id DESC LIMIT 1", (task_id, _RECORD + "{%")).fetchone()
    handed = bool(leg and leg["ended_at"] and leg["outcome"] in ("completed", "handed_off"))
    if row["status"] not in _FINISHED and not handed:
        raise db.NawabanError(
            f"不收工 {task_id}:卡还没完成也没交接(当前 {row['status']})")
    if event is None:
        raise db.NawabanError(f"不收工 {task_id}:卡上没有派发记录,不知道该关哪个会话")
    record = json.loads(event["body"][len(_RECORD):])

    stopped = _stop(record)
    if stopped is None:
        raise db.NawabanError(f"不收工 {task_id}:派发记录里没有会话编号,请手工停掉会话")
    if stopped.returncode and _session(task_id.lower()):
        raise db.NawabanError(
            f"收工 {task_id} 失败:会话没停掉,工位未动 —— {(stopped.stderr or stopped.stdout).strip()}")
    what = f"窗格 {record['pane']}" if record["pane"] else f"会话 {record['session']}"
    lines = [what + (" 已经不在" if stopped.returncode else " 已关" if record["pane"] else " 已停")]

    worktree = Path(record["worktree"])
    if not worktree.is_dir():
        lines.append("工位已不存在")
    elif keep := _unsaved(worktree):
        lines.append(f"工位没清理:{keep} → {worktree}")
    else:
        git = ("git", "-C", record["root"])
        # 会话给自己的工位上了锁,停掉后锁还在;上面已确认会话停了、工位里没有会丢的东西。
        _run(*git, "worktree", "unlock", str(worktree))
        removed = _run(*git, "worktree", "remove", str(worktree))
        if not removed.returncode:
            # -d 只删已并入当前分支的分支,带着没合并提交的分支会留下。
            _run(*git, "branch", "-d", f"worktree-{task_id.lower()}")
        lines.append(f"工位没清理:{removed.stderr.strip()}" if removed.returncode
                     else f"工位已清理 {worktree}")
    db.add_event(path, task_id, kind="coord", author=author, body="dismiss · " + " · ".join(lines))
    return lines


def _unsaved(worktree: Path) -> str | None:
    """工位里还有会丢的东西就说出是什么;查不了也当有。"""
    status = _run("git", "-C", str(worktree), "status", "--porcelain")
    ahead = _run("git", "-C", str(worktree), "log", "--oneline", "HEAD", "--not", "--remotes")
    if status.returncode or ahead.returncode:
        return "查不了工位状态"
    if status.stdout.strip():
        return "还有没提交的改动"
    if ahead.stdout.strip():
        return "还有没推送的提交"
    return None
