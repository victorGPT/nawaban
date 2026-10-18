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
from pathlib import Path

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

def _roots(cwd: Path | None = None) -> list[Path]:
    """The shared git checkout first (so every worktree maps to it), then cwd and its ancestors."""
    cur = (cwd or Path.cwd()).resolve()
    roots = []
    try:
        r = subprocess.run(["git", "-C", str(cur), "rev-parse", "--git-common-dir"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            roots.append((cur / r.stdout.strip()).resolve().parent)
    except (OSError, subprocess.SubprocessError):
        pass
    return [*roots, cur, *cur.parents]


def _board_root() -> Path | None:
    return next((r for r in _roots() if (r / ".nawaban").is_dir()), None)


def resolve_db(arg: str | None) -> Path:
    if arg:
        return Path(arg).expanduser()
    if os.environ.get("NAWABAN_DB"):
        return Path(os.environ["NAWABAN_DB"]).expanduser()
    return (_board_root() or _roots()[0]) / ".nawaban" / "nawaban.db"


def default_project(db: Path) -> str | None:
    """The repository of the board directory the command runs in, else the one holding --db."""
    root = _board_root()
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


def open_board(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise Refused(f"看板不存在:{path}(建新板用 init)")
    if _version(path) != VERSION:
        raise Refused(f"不是新版看板:{path}")
    return _connect(path)


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


def _status(t: sqlite3.Row) -> str:
    """In progress is derived: a session holds an open task."""
    return "in_progress" if t["status"] == "open" and t["session"] else t["status"]


# ── verbs ─────────────────────────────────────────────────────────

def create(con, path: Path, a) -> str:
    if not re.fullmatch(r"\S+", a.id):
        raise Refused(f"任务 id 不能为空或含空白:{a.id!r}")
    body = Path(a.body_file).read_text(encoding="utf-8") if a.body_file else a.body
    project = a.project
    if a.parent:
        project = project or _task(con, a.parent)["project"]
    else:
        project = project or default_project(path)
    try:
        with con:
            con.execute("INSERT INTO tasks (id, project, parent, title, body, created_at)"
                        " VALUES (?,?,?,?,?,?)",
                        (a.id, project, a.parent, a.title, body, int(time.time())))
    except sqlite3.IntegrityError:
        raise Refused(f"任务已存在:{a.id}") from None
    return f"✓ create {a.id} · 项目 {project or '-'}"


def event(con, a) -> str:
    _task(con, a.id)
    author = "user" if a.by else identity()
    with con:
        con.execute("INSERT INTO events (task, at, author, kind, body) VALUES (?,?,?,?,?)",
                    (a.id, int(time.time()), author, a.kind, a.body))
    return f"✓ event {a.id} · {a.kind}"


def show(con, a, limit: int = 20) -> str:
    t = _task(con, a.id)
    events = con.execute("SELECT * FROM events WHERE task=? ORDER BY id DESC", (a.id,)).fetchall()
    head = [f"状态 {_status(t)}", f"项目 {t['project'] or '-'}"]
    if t["parent"]:
        head.append(f"父任务 {t['parent']}")
    if t["session"]:
        head.append(f"会话 {t['session']}")
    head.append(f"建于 {_when(t['created_at'])}")
    lines = [f"[{t['id']}] {t['title']}", "  " + " · ".join(head)]
    note = next((e for e in events if e["kind"] == "note"), None)
    if note:
        lines.append(f"  当前进度:{note['body']}")
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
    rows = con.execute(sql + " ORDER BY created_at, id", args).fetchall()
    return "\n".join(f"{t['id']}  {_status(t)}  {t['project'] or '-'}  {t['title']}" for t in rows)


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
    sub.add_parser("backup", help="备份到 <看板目录>/backups/ · 保留 14 天")
    return ap


def main(argv: list[str] | None = None) -> int:
    a = _parser().parse_args(argv)
    path = resolve_db(a.db)
    try:
        if a.verb == "init":
            print(f"✓ init → {path}" if init(path) else f"✓ 看板已存在:{path}")
            return 0
        con = open_board(path)
        try:
            if a.verb == "backup":
                out = f"✓ backup → {backup(path)}"
            elif a.verb == "create":
                out = create(con, path, a)
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
