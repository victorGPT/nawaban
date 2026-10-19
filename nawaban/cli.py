#!/usr/bin/env python3
"""nawaban tracker: one task record and one event log per task (spec NAWABAN-LEAN).

Identity comes only from the environment: CLAUDE_CODE_SESSION_ID, then NAWABAN_OWNER.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # run as a script, too
from nawaban import old_board  # noqa: E402

VERSION = 1  # PRAGMA user_version; old-schema boards read 0
SCHEMA = """
CREATE TABLE tasks (
    id         TEXT PRIMARY KEY,
    project    TEXT,
    parent     TEXT REFERENCES tasks(id),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
    session    TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE blockers (
    task    TEXT NOT NULL REFERENCES tasks(id),
    blocker TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task, blocker)
);
CREATE TABLE events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    task   TEXT NOT NULL REFERENCES tasks(id),
    at     INTEGER NOT NULL,
    author TEXT NOT NULL,
    kind   TEXT NOT NULL CHECK (kind IN ('note','status','decision','link')),
    body   TEXT NOT NULL
);
CREATE INDEX idx_tasks_parent ON tasks(parent);
CREATE INDEX idx_blockers_blocker ON blockers(blocker);
CREATE INDEX idx_events_task ON events(task, id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
"""


class Refused(Exception):
    """A command refused: printed as ✗ with exit 1."""


# ── board location ────────────────────────────────────────────────

def _repo_root(cur: Path) -> Path | None:
    """The main checkout of the git repository cur is in (a worktree maps to it)."""
    try:
        r = subprocess.run(["git", "-C", str(cur), "rev-parse", "--git-common-dir"],
                           capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return (cur / r.stdout.strip()).resolve().parent if r.returncode == 0 else None


def _roots(cwd: Path | None = None) -> list[Path]:
    """The shared git checkout first (so every worktree maps to it), then cwd and its ancestors."""
    cur = (cwd or Path.cwd()).resolve()
    repo = _repo_root(cur)
    return [*([repo] if repo else []), cur, *cur.parents]


def _board_root() -> Path | None:
    return next((r for r in _roots() if (r / ".nawaban").is_dir()), None)


def resolve_db(arg: str | None) -> Path:
    if arg:
        return Path(arg).expanduser()
    if os.environ.get("NAWABAN_DB"):
        return Path(os.environ["NAWABAN_DB"]).expanduser()
    return (_board_root() or _roots()[0]) / ".nawaban" / "nawaban.db"


def default_project(db: Path) -> str | None:
    """The repository the command runs in, else the one holding the board.

    A .nawaban directory above cwd says nothing: one in $HOME would name every task after the user.
    """
    root = _repo_root(Path.cwd().resolve())
    if root:
        return root.name
    d = db.absolute().parent
    return d.parent.name if d.name == ".nawaban" else None


# ── storage ───────────────────────────────────────────────────────

def _connect(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(path), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _version(path: Path) -> int | None:
    """user_version of a board file, None when it has old tables or is not SQLite."""
    try:
        con = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True)
        try:
            v = con.execute("PRAGMA user_version").fetchone()[0]
            tables = con.execute("SELECT count(*) FROM sqlite_master").fetchone()[0]
        finally:
            con.close()
    except sqlite3.DatabaseError:
        return None
    return v if v == VERSION or not tables else None


def init(path: Path) -> bool:
    """Create an empty board; False when one already exists there."""
    if path.exists():
        v = _version(path)
        if v is None:
            raise Refused(f"不是新版看板:{path}")
        if v == VERSION:
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    con = _connect(path)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(SCHEMA + f"PRAGMA user_version={VERSION};")
    finally:
        con.close()
    return True


def _check_board(path: Path) -> None:
    if not path.exists():
        raise Refused(f"看板不存在:{path}(建新板用 init)")
    if _version(path) != VERSION:
        raise Refused(f"不是新版看板:{path}")


def open_board(path: Path) -> sqlite3.Connection:
    _check_board(path)
    return _connect(path)


def open_readonly(path: Path | str) -> sqlite3.Connection:
    """The board opened read-only (the web page); refuses a missing or old-schema file."""
    path = Path(path)
    _check_board(path)
    con = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def _task(con: sqlite3.Connection, task_id: str) -> sqlite3.Row:
    row = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if row is None:
        raise Refused(f"任务不存在:{task_id}")
    return row


def identity() -> str:
    who = os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("NAWABAN_OWNER")
    if not who:
        raise Refused("身份缺失:需 CLAUDE_CODE_SESSION_ID 环境变量;没有它的环境(如 Codex)请设 NAWABAN_OWNER")
    return who


def _when(ts: int) -> str:
    return _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def derived_status(t: sqlite3.Row) -> str:
    """In progress is derived: a session holds an open task."""
    return "in_progress" if t["status"] == "open" and t["session"] else t["status"]


def blocked_by(con, task_id: str) -> list[sqlite3.Row]:
    return con.execute("SELECT t.* FROM blockers b JOIN tasks t ON t.id=b.blocker WHERE b.task=?"
                       " ORDER BY t.id", (task_id,)).fetchall()


def dependents(con, task_id: str) -> list[sqlite3.Row]:
    return con.execute("SELECT t.* FROM blockers b JOIN tasks t ON t.id=b.task WHERE b.blocker=?"
                       " ORDER BY t.id", (task_id,)).fetchall()


def add_event(con, task_id: str, author: str, kind: str, body: str, at: int | None = None) -> None:
    con.execute("INSERT INTO events (task, at, author, kind, body) VALUES (?,?,?,?,?)",
                (task_id, int(time.time()) if at is None else at, author, kind, body))


def _status_event(con, task_id: str, who: str, frm: str, to: str, note: str = "") -> None:
    """Status bodies read `<from>→<to>`, the same shape migrated old events have."""
    add_event(con, task_id, who, "status", f"{frm}→{to}" + (f" · {note}" if note else ""))


def _add_blocker(con, task_id: str, blocker: str) -> None:
    _task(con, task_id)
    _task(con, blocker)
    if task_id == blocker:
        raise Refused(f"任务不能被自己挡住:{task_id}")
    # A cycle closes when walking up from the blocker through its own blockers reaches the task.
    cycle = con.execute(
        "WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT b.blocker FROM blockers b JOIN up ON b.task=up.id)"
        " SELECT 1 FROM up WHERE id=?", (blocker, task_id)).fetchone()
    if cycle:
        raise Refused(f"会成环:{blocker} 已经(间接)被 {task_id} 挡住")
    con.execute("INSERT OR IGNORE INTO blockers (task, blocker) VALUES (?,?)", (task_id, blocker))


# ── verbs ─────────────────────────────────────────────────────────

def create(con, path: Path, a) -> str:
    if not re.fullmatch(r"\S+", a.id):
        raise Refused(f"任务 id 不能为空或含空白:{a.id!r}")
    body = Path(a.body_file).read_text(encoding="utf-8") if a.body_file else a.body
    parent = _task(con, a.parent) if a.parent else None
    project = a.project or (parent["project"] if parent else default_project(path))
    if con.execute("SELECT 1 FROM tasks WHERE id=?", (a.id,)).fetchone():
        raise Refused(f"任务已存在:{a.id}")
    try:
        with con:
            con.execute("INSERT INTO tasks (id, project, parent, title, body, created_at)"
                        " VALUES (?,?,?,?,?,?)",
                        (a.id, project, a.parent, a.title, body, int(time.time())))
            for blocker in a.blocked_by or ():
                _add_blocker(con, a.id, blocker)
    except sqlite3.IntegrityError:  # another session created the same id in between
        raise Refused(f"任务已存在:{a.id}") from None
    return f"✓ create {a.id} · 项目 {project or '-'}"


def block(con, a) -> str:
    with con:
        _add_blocker(con, a.id, a.blocker)
    return f"✓ block {a.id} · 被挡:{a.blocker}"


def claim(con, a) -> str:
    t = _task(con, a.id)
    who = identity()
    holder = t["session"]
    if holder and holder != who and not a.take:
        raise Refused(f"{a.id} 在窗口 {holder} 手上;确要接手加 --take")
    if a.release:
        if not holder:
            return f"✓ {a.id} 本就没人认领"
        with con:
            con.execute("UPDATE tasks SET session=NULL WHERE id=?", (a.id,))
            _status_event(con, a.id, who, derived_status(t), t["status"],
                          "" if holder == who else f"释放 {holder} 的认领")
        return f"✓ release {a.id}"
    if t["status"] != "open":
        raise Refused(f"{a.id} 已是 {t['status']},不能认领;要重做先 close --reopen")
    if holder == who:
        return f"✓ {a.id} 已在本窗口 {who} 手上"
    with con:
        con.execute("UPDATE tasks SET session=? WHERE id=?", (who, a.id))
        _status_event(con, a.id, who, derived_status(t), "in_progress", f"接手自 {holder}" if holder else "")
    return f"✓ claim {a.id} · 窗口 {who}"


def close(con, a) -> str:
    t = _task(con, a.id)
    who = identity()
    to = "done" if a.done else "cancelled" if a.cancelled else "open"
    if t["status"] == to:
        return f"✓ {a.id} 已是 {to}"
    with con:
        # Closing clears the session; reopening keeps none either, so the task returns to the frontier.
        con.execute("UPDATE tasks SET status=?, session=NULL WHERE id=?", (to, a.id))
        _status_event(con, a.id, who, derived_status(t), to)
    return f"✓ close {a.id} → {to}"


def event(con, a) -> str:
    _task(con, a.id)
    author = "user" if a.by else identity()
    with con:
        add_event(con, a.id, author, a.kind, a.body)
    return f"✓ event {a.id} · {a.kind}"


def show(con, a, limit: int = 20) -> str:
    t = _task(con, a.id)
    events = con.execute("SELECT * FROM events WHERE task=? ORDER BY id DESC", (a.id,)).fetchall()
    head = [f"状态 {derived_status(t)}", f"项目 {t['project'] or '-'}"]
    if t["parent"]:
        head.append(f"父任务 {t['parent']}")
    if t["session"]:
        head.append(f"窗口 {t['session']}")
    head.append(f"建于 {_when(t['created_at'])}")
    lines = [f"[{t['id']}] {t['title']}", "  " + " · ".join(head)]
    # A closed task's latest note can be stale (migrated tasks keep their last progress line).
    note = next((e for e in events if e["kind"] == "note"), None) if t["status"] == "open" else None
    if note:
        lines.append(f"  当前进展:{note['body']}")
    for label, rows in (("被挡", blocked_by(con, a.id)), ("下游任务", dependents(con, a.id))):
        if rows:
            lines.append(f"  {label}:" + " · ".join(f"{r['id']} {derived_status(r)}" for r in rows))
    lines += ["", t["body"], ""]
    lines.append(f"最近事件(最新在前 · 共 {len(events)} 条):")
    lines += [f"  [{_when(e['at'])} · {e['kind']} · {e['author']}] {e['body']}" for e in events[:limit]]
    return "\n".join(lines)


def list_tasks(con, a) -> str:
    sql, args = "SELECT * FROM tasks WHERE 1=1", []
    if a.project:
        sql += " AND project=?"
        args.append(a.project)
    if a.parent:
        _task(con, a.parent)
        sql += " AND parent=?"
        args.append(a.parent)
    if a.frontier:
        sql += (" AND status='open' AND session IS NULL AND NOT EXISTS (SELECT 1 FROM blockers b"
                " JOIN tasks x ON x.id=b.blocker WHERE b.task=tasks.id AND x.status='open')")
    rows = con.execute(sql + " ORDER BY created_at, id", args).fetchall()
    return "\n".join(f"{t['id']}  {derived_status(t)}  {t['project'] or '-'}  {t['title']}" for t in rows)


def backup(path: Path, keep_days: int = 14) -> Path:
    """Online copy into <board dir>/backups/, pruning copies older than keep_days."""
    bdir = path.parent / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    dest_path = bdir / f"nawaban-{_dt.datetime.now():%Y%m%d-%H%M%S}.db"
    src, dest = sqlite3.connect(str(path)), sqlite3.connect(str(dest_path))
    try:
        src.backup(dest)
    finally:
        dest.close()
        src.close()
    cutoff = time.time() - keep_days * 86400
    for old in bdir.glob("nawaban-*.db"):
        if old.stat().st_mtime < cutoff:
            old.unlink()
    return dest_path


# ── migrate from an old-schema board ──────────────────────────────

def _copy_old(old, con) -> tuple[int, int, int]:
    """Copy every task, its events and its edges in one transaction; returns (tasks, events, skipped edges)."""
    tasks = old_board.tasks(old)
    n_events = skipped = 0
    with con:
        for row, evs in tasks:
            con.execute("INSERT INTO tasks (id, project, title, body, status, session, created_at)"
                        " VALUES (:id,:project,:title,:body,:status,:session,:created_at)", row)
            for at, author, kind, body in evs:
                add_event(con, row["id"], author, kind, body, at)
            n_events += len(evs)
        ids = {row["id"] for row, _ in tasks}
        for kind, src, dst in old_board.edges(old):
            if src not in ids or dst not in ids:
                skipped += 1  # the old board never enforced its foreign keys
            elif kind == "split_from":
                con.execute("UPDATE tasks SET parent=? WHERE id=?", (dst, src))
            else:
                con.execute("INSERT INTO blockers (task, blocker) VALUES (?,?)", (src, dst))
    return len(tasks), n_events, skipped


def migrate(old_path: Path, new_path: Path) -> str:
    """Read an old-schema board (read-only) into an empty new board."""
    if not old_path.exists():
        raise Refused(f"旧看板不存在:{old_path}")
    with closing(sqlite3.connect(old_path.absolute().as_uri() + "?mode=ro", uri=True)) as old:
        old.row_factory = sqlite3.Row
        try:
            tables = {r[0] for r in old.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        except sqlite3.DatabaseError:
            tables = set()
        if not old_board.TABLES <= tables:
            raise Refused(f"不是旧版看板:{old_path}")
        init(new_path)
        with closing(open_board(new_path)) as con:
            if con.execute("SELECT 1 FROM tasks LIMIT 1").fetchone():
                raise Refused(f"目标看板已有任务,拒绝迁移:{new_path}")
            try:
                n_tasks, n_events, skipped = _copy_old(old, con)
            except (sqlite3.Error, IndexError) as e:  # IndexError: a column the old schema should have
                raise Refused(f"迁移失败,新看板未写入:{type(e).__name__}: {e}") from None
    out = f"✓ migrate {old_path} → {new_path} · 任务 {n_tasks} · 事件 {n_events}"
    return out + (f" · 跳过悬空关系 {skipped}" if skipped else "")


# ── entry ─────────────────────────────────────────────────────────

def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="nawaban", allow_abbrev=False)
    ap.add_argument("--db", help="看板文件(默认 NAWABAN_DB,再找最近的 .nawaban/nawaban.db)")
    sub = ap.add_subparsers(dest="verb", required=True)
    sub.add_parser("init", help="建空看板")
    p = sub.add_parser("create", help="建任务")
    p.add_argument("id")
    p.add_argument("--title", required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--body")
    g.add_argument("--body-file")
    p.add_argument("--parent")
    p.add_argument("--project")
    p.add_argument("--blocked-by", action="append", metavar="ID", help="可重复")
    p = sub.add_parser("block", help="记被挡:id 被 blocker 挡住,blocker 关闭前不可开工")
    p.add_argument("id")
    p.add_argument("blocker")
    p = sub.add_parser("claim", help="认领;--release 交还")
    p.add_argument("id")
    p.add_argument("--take", action="store_true", help="接手别的窗口手上的任务")
    p.add_argument("--release", action="store_true")
    p = sub.add_parser("close", help="关闭或重开")
    p.add_argument("id")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--done", action="store_true")
    g.add_argument("--cancelled", action="store_true")
    g.add_argument("--reopen", action="store_true")
    p = sub.add_parser("event", help="记事件:note / decision / link")
    p.add_argument("id")
    p.add_argument("--kind", required=True, choices=("note", "decision", "link"))
    p.add_argument("--body", required=True)
    p.add_argument("--by", choices=("user",), help="user = 用户拍板")
    p = sub.add_parser("show", help="看一个任务")
    p.add_argument("id")
    p = sub.add_parser("list", help="列任务")
    p.add_argument("--project")
    p.add_argument("--parent")
    p.add_argument("--frontier", action="store_true", help="只列可开工:未关闭、没人认领、前置都已关闭")
    sub.add_parser("backup", help="备份到 <看板目录>/backups/ · 保留 14 天")
    p = sub.add_parser("migrate", help="把旧结构看板迁成新看板(只读旧文件 · 目标已有任务就拒绝)")
    p.add_argument("old")
    p.add_argument("new")
    return ap


def main(argv: list[str] | None = None) -> int:
    a = _parser().parse_args(argv)
    path = resolve_db(a.db)
    try:
        if a.verb == "init":
            print(f"✓ init → {path}" if init(path) else f"✓ 看板已存在:{path}")
            return 0
        if a.verb == "migrate":
            print(migrate(Path(a.old).expanduser(), Path(a.new).expanduser()))
            return 0
        con = open_board(path)
        try:
            if a.verb == "backup":
                out = f"✓ backup → {backup(path)}"
            elif a.verb == "create":
                out = create(con, path, a)
            elif a.verb == "block":
                out = block(con, a)
            elif a.verb == "claim":
                out = claim(con, a)
            elif a.verb == "close":
                out = close(con, a)
            elif a.verb == "event":
                out = event(con, a)
            elif a.verb == "show":
                out = show(con, a)
            else:
                out = list_tasks(con, a)
        finally:
            con.close()
    except (Refused, OSError) as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1
    if out:
        print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
