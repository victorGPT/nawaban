#!/usr/bin/env python3
"""nawaban tracker: one task record and one event log per task (spec NAWABAN-LEAN).

Identity comes only from the environment: CLAUDE_CODE_SESSION_ID, then NAWABAN_OWNER.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from contextlib import closing
from decimal import Decimal
from pathlib import Path

VERSION = 2  # PRAGMA user_version; old-schema boards read 0, a pre-OKR board 1 (migrated on open)
# OKR readings (spec NAWABAN-OKRP): source '' not NULL, so UNIQUE holds for a reading with none
OKR_SCHEMA = """
CREATE TABLE IF NOT EXISTS kr_readings (
    repo        TEXT NOT NULL,
    kr          TEXT NOT NULL,
    value       REAL NOT NULL,
    as_of       TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT '',
    measured_at TEXT NOT NULL,
    UNIQUE (repo, kr, as_of, source)
);
CREATE TABLE IF NOT EXISTS okr_accepts (
    repo        TEXT NOT NULL,
    objective   TEXT NOT NULL,
    accepted_at TEXT NOT NULL
);
"""
SCHEMA = OKR_SCHEMA + """
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
    return v if v in (1, VERSION) or not tables else None


def _migrate(path: Path) -> None:
    """Version 1 → 2: back the board up, then add the OKR tables (idempotent if two processes race)."""
    backup(path)
    con = _connect(path)
    try:
        con.executescript(f"BEGIN IMMEDIATE; {OKR_SCHEMA} PRAGMA user_version={VERSION}; COMMIT;")
    finally:
        con.close()


def init(path: Path) -> bool:
    """Create an empty board; False when one already exists there."""
    if path.exists():
        v = _version(path)
        if v is None:
            raise Refused(f"不是新版看板:{path}")
        if v == 1:
            _migrate(path)
        if v in (1, VERSION):
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
    v = _version(path)
    if v == 1:
        _migrate(path)
    elif v != VERSION:
        raise Refused(f"不是新版看板:{path}")


def open_board(path: Path) -> sqlite3.Connection:
    _check_board(path)
    return _connect(path)


def open_readonly(path: Path | str) -> sqlite3.Connection:
    """The board opened read-only (the json verb); refuses a missing or old-schema file."""
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


def add_event(con, task_id: str, author: str, kind: str, body: str) -> None:
    con.execute("INSERT INTO events (task, at, author, kind, body) VALUES (?,?,?,?,?)",
                (task_id, int(time.time()), author, kind, body))


def _status_event(con, task_id: str, who: str, frm: str, to: str, note: str = "") -> None:
    """Status bodies read `<from>→<to>`, the same shape migrated old events have."""
    add_event(con, task_id, who, "status", f"{frm}→{to}" + (f" · {note}" if note else ""))


def herdr_terminal() -> str | None:
    """The Herdr terminal a Claude Code session runs in; None outside Herdr or for NAWABAN_OWNER."""
    return os.environ.get("HC_TERMINAL_ID") if os.environ.get("CLAUDE_CODE_SESSION_ID") else None


_TERMINAL = re.compile(r" · terminal (\S+)$")


def held_terminal(con, task_id: str, session: str | None) -> str | None:
    """The terminal named by the holding session's latest claim (`→in_progress`) event; None if it names none."""
    if not session:
        return None
    r = con.execute("SELECT body FROM events WHERE task=? AND kind='status' AND author=?"
                    " AND body LIKE '%→in_progress%' ORDER BY id DESC LIMIT 1",
                    (task_id, session)).fetchone()
    m = _TERMINAL.search(r["body"]) if r else None
    return m.group(1) if m else None


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
    here = herdr_terminal()
    # The holder claiming again only records a move to another terminal.
    if holder == who and (not here or here == held_terminal(con, a.id, who)):
        return f"✓ {a.id} 已在本窗口 {who} 手上"
    note = " · ".join(filter(None, [f"接手自 {holder}" if holder and holder != who else "",
                                     f"terminal {here}" if here else ""]))
    with con:
        con.execute("UPDATE tasks SET session=? WHERE id=?", (who, a.id))
        _status_event(con, a.id, who, derived_status(t), "in_progress", note)
    return f"✓ claim {a.id} · 窗口 {who}" + (f" · terminal {here}" if here else "")


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


def card(a) -> None:
    """Spec NAWABAN-OKR: an ask is a decision card hung on a KR; a decision may name the KR it serves."""
    if a.kr and a.kind not in ("ask", "decision"):
        raise Refused("--kr 只给 ask(待决)和 decision")
    if a.kind != "ask":
        if a.context or a.option or a.rec:
            raise Refused("--context / --option / --rec 只给 ask(待决)")
        if a.kr:
            a.body = f"[{a.kr}] {a.body}"
        return
    missing = [f for f, v in (("--kr", a.kr), ("--context", a.context), ("--rec", a.rec)) if not v]
    if len(a.option or []) < 2:
        missing.append("--option(至少两个)")
    if missing:
        raise Refused("决策卡缺 " + " ".join(missing))
    a.body = "\n".join([f"【Decision】{a.body}", f"【Objective / KR】{a.kr}", f"【Context】{a.context}",
                        "【Options】", *(f"- {o}" for o in a.option), f"【Recommendation】{a.rec}"])


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


# ── json: read-only projections for the Herdr panel ───────────────

COLUMNS = ("open", "in_progress", "done")
DONE_LIMIT = 12  # the done column shows only the latest few
DONE_RECENT = 24 * 3600  # ...plus every task done this recently
DECISIONS_RECENT = 48 * 3600  # `decisions`: every decision this recent, open task or closed


def _ref(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "title": r["title"], "status": derived_status(r)}


def _event(r: sqlite3.Row) -> dict:
    return {"kind": r["kind"], "body": r["body"], "author": r["author"], "at": r["at"]}


def _triage_notes(con) -> list[sqlite3.Row]:
    """Each open task's latest `triage:` note, with the task's project."""
    return con.execute(
        "SELECT e.task, NULLIF(t.project,'') AS project, e.body FROM events e JOIN tasks t ON t.id=e.task"
        " WHERE t.status='open' AND e.id=(SELECT MAX(id) FROM events"
        " WHERE task=e.task AND kind='note' AND ltrim(body) LIKE 'triage:%')").fetchall()


def projects_data(path: Path | str) -> dict:
    with closing(open_readonly(path)) as con:
        rows = con.execute(
            "SELECT NULLIF(project,'') AS name, SUM(status='open') AS open, count(*) AS total"
            " FROM tasks GROUP BY name ORDER BY name IS NULL, name").fetchall()
        waiting = Counter(r["project"] for r in _triage_notes(con) if waiting_question(r["body"]) is not None)
        return {"projects": [dict(r) | {"waiting": waiting[r["name"]]} for r in rows]}


_NEEDS_INFO = re.compile(r"triage:\s*needs-info[\s—–:：-]*(?:等你\s*[:：])?\s*")


def waiting_question(triage_note: str | None) -> str | None:
    """What a task waits on the user for: the latest `triage:` note's question when it is
    `triage: needs-info — 等你：<question>`, without that lead-in; None for any other label."""
    m = _NEEDS_INFO.match(triage_note.strip()) if triage_note else None
    return triage_note.strip()[m.end():] if m else None


_VERDICT = re.compile(r"^\s*Verdict:\s*(.*)$", re.M)


def _verdict(body: str) -> str:
    """The text after `Verdict:` on its line, else the decision's first line."""
    m = _VERDICT.search(body)
    return m.group(1).strip() if m else body.strip().split("\n", 1)[0]


def board_data(path: Path | str, project: str | None = None) -> dict:
    """Tasks in three columns, latest activity first."""
    sql = ("SELECT t.*, MAX(COALESCE(e.at, t.created_at)) AS active_at,"
           " (SELECT count(*) FROM blockers b JOIN tasks x ON x.id=b.blocker"
           "  WHERE b.task=t.id AND x.status='open') AS open_blockers,"
           " (SELECT at FROM events WHERE task=t.id AND kind='status' AND body LIKE '%→in_progress%'"
           "  ORDER BY id LIMIT 1) AS claimed_at,"
           " (SELECT author FROM events WHERE task=t.id AND kind='status' AND body LIKE '%→in_progress%'"
           "  ORDER BY id DESC LIMIT 1) AS last_claimer,"
           " (SELECT at FROM events WHERE task=t.id AND kind='status' AND body LIKE '%→done%'"
           "  ORDER BY id DESC LIMIT 1) AS done_at,"
           " (SELECT status='open' FROM tasks p WHERE p.id=t.parent) AS parent_open"
           " FROM tasks t LEFT JOIN events e ON e.task=t.id WHERE t.status!='cancelled'")
    args: dict = {}
    if project is not None:
        sql += " AND COALESCE(t.project,'')=:project"
        args["project"] = project
    with closing(open_readonly(path)) as con:
        rows = con.execute(sql + " GROUP BY t.id ORDER BY active_at DESC, t.id", args).fetchall()
        # Open tasks only: the latest note that is not `coord:` bookkeeping (current progress),
        # and the open tasks in their way.
        notes = {r["task"]: {"body": r["body"], "at": r["at"]} for r in con.execute(
            "SELECT e.task, e.body, e.at FROM events e JOIN tasks t ON t.id=e.task"
            " WHERE t.status='open' AND e.id=(SELECT MAX(id) FROM events"
            " WHERE task=e.task AND kind='note' AND ltrim(body) NOT LIKE 'coord:%')")}
        # GLOSSARY Leader: the author of the latest dispatch note (agent-center writes `coord: dispatch …`).
        dispatchers = {r["task"]: r["author"] for r in con.execute(
            "SELECT e.task, e.author FROM events e WHERE e.id=(SELECT MAX(id) FROM events"
            " WHERE task=e.task AND kind='note'"
            " AND (ltrim(body) LIKE 'dispatch:%' OR ltrim(body) LIKE 'coord: dispatch%'))")}
        decisions = {r["task"]: {"at": r["at"], "verdict": _verdict(r["body"])} for r in con.execute(
            "SELECT e.task, e.body, e.at FROM events e JOIN tasks t ON t.id=e.task"
            " WHERE t.status='open' AND e.id=(SELECT MAX(id) FROM events"
            " WHERE task=e.task AND kind='decision')")}
        decided = [{"task": r["task"], "at": r["at"], "verdict": _verdict(r["body"]), "owner": r["author"] == "user"}
                  for r in con.execute(
            "SELECT e.* FROM events e JOIN tasks t ON t.id=e.task WHERE e.kind='decision' AND e.at>=:since"
            " AND t.status!='cancelled'" + (" AND COALESCE(t.project,'')=:project" if project is not None else "")
            + " ORDER BY e.at DESC, e.id DESC", args | {"since": time.time() - DECISIONS_RECENT})]
        triage = {r["task"]: r["body"] for r in _triage_notes(con)}
        terminals = {r["id"]: held_terminal(con, r["id"], r["session"])
                     for r in rows if r["status"] == "open" and r["session"]}
        blockers: dict[str, list[str]] = {}
        for r in con.execute("SELECT b.task, b.blocker FROM blockers b JOIN tasks x ON x.id=b.blocker"
                             " WHERE x.status='open' ORDER BY b.blocker"):
            blockers.setdefault(r["task"], []).append(r["blocker"])
    columns = {key: [] for key in COLUMNS}
    recent = time.time() - DONE_RECENT
    for r in rows:
        status = derived_status(r)
        # Past the latest few, done tasks stay only while recent or under an open spec (the panel ticks them).
        if (status == "done" and len(columns["done"]) >= DONE_LIMIT
                and not r["parent_open"] and (r["done_at"] or 0) < recent):
            continue
        task = {
            "id": r["id"], "title": r["title"], "status": status, "project": r["project"],
            "parent": r["parent"], "session": r["session"], "created_at": r["created_at"],
            "active_at": r["active_at"], "open_blockers": r["open_blockers"],
            "terminal": terminals.get(r["id"]), "leader": dispatchers.get(r["id"], r["session"] or r["last_claimer"]),
            "claimed_at": r["claimed_at"]}
        if r["status"] == "open":
            task["progress"] = notes.get(r["id"])
            task["blocked_by"] = blockers.get(r["id"], [])
            task["waiting"] = waiting_question(triage.get(r["id"]))
            task["decision"] = decisions.get(r["id"])
        if status == "done":
            task["done_at"] = r["done_at"]
        columns[status].append(task)
    return {"columns": [{"key": k, "tasks": v} for k, v in columns.items()], "decisions": decided}


# ── json board from GitHub issues (spec NAWABAN-INDEX, Data mapping) ──

GH_RECENT = 48 * 3600  # closed issues stay this long
PENDING_NOTES = 3  # a pending decision carries its issue's last this many 进展
_GH_FIELDS = "number,url,title,state,stateReason,closedAt,createdAt,updatedAt,labels,body,comments,parent,assignees"
_GH_PARENT_TITLE = re.compile(r"[(（]#(\d+)-[A-Za-z]+[)）]")  # (#236-B)
_GH_PARENT_BODY = re.compile(r"(?:属于|Part of|Parent:)\s*#(\d+)")
# `决定：`, `## 进展：`, `**进展**：`, `决定（roubao-e8）：`: optional heading/bold, the word, an optional (who), a colon.
_GH_PREFIX = r"\s*(?:#{{1,6}}\s*)?\**{}\**\s*([（(][^）)\n]*[）)])?\**\s*[：:]\**\s*"
_GH_TERMINAL = re.compile(r"\bhc (t\w+)")  # 认领：gh-275（hc t52）
_GH_NEXT = re.compile(r"下一步[：:]\s*([^。\n]+)")  # the sentence after it


def github_root(cwd: Path | None = None) -> Path | None:
    """The repository cwd is in, when its docs/agents/issue-tracker.md's first heading names GitHub."""
    root = _repo_root((cwd or Path.cwd()).resolve())
    try:
        lines = (root / "docs" / "agents" / "issue-tracker.md").read_text().splitlines() if root else []
    except OSError:
        return None
    heading = next((ln for ln in lines if ln.startswith("#")), "")
    return root if "GitHub" in heading else None


def _gh(root: Path, *args: str) -> str:
    """`gh *args` output, run as another logged-in account when the active one cannot see the repository."""
    import json
    def gh(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(["gh", *args], cwd=root, capture_output=True, text=True, timeout=30, env=env)
        except (OSError, subprocess.SubprocessError) as e:
            raise Refused(f"gh 不可用:{e}") from e

    def others() -> list[str]:
        """The logged-in gh accounts that are not active: sessions share one gh, the last to switch wins."""
        r = gh("auth", "status", "--json", "hosts")
        try:
            return [a["login"] for a in json.loads(r.stdout)["hosts"]["github.com"] if not a.get("active")]
        except (ValueError, KeyError, TypeError):
            return []

    r = gh(*args)
    if r.returncode != 0 and "Could not resolve to a Repository" in r.stderr:
        for login in others():
            env = os.environ | {"GH_TOKEN": gh("auth", "token", "--user", login).stdout.strip()}
            if (retry := gh(*args, env=env)).returncode == 0:
                r = retry
                break
    if r.returncode != 0:
        raise Refused(f"gh 失败:{r.stderr.strip()}")
    return r.stdout


def _gh_json(root: Path, *args: str):
    import json
    return json.loads(_gh(root, *args))


def _gh_issues(root: Path) -> list[dict]:
    """Open issues plus those closed in the last GH_RECENT seconds, as `gh issue list --json` gives them."""
    since = _dt.datetime.fromtimestamp(time.time() - GH_RECENT, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [i for state in (["--state", "open"], ["--state", "closed", "--search", f"closed:>={since}"])
            for i in _gh_json(root, "issue", "list", *state, "--limit", "1000", "--json", _GH_FIELDS)]


# ── OKR progress (spec NAWABAN-OKR) ──

OKR_FILE = "docs/agents/okr.toml"
MEASURE_TIMEOUT = 60  # seconds per KR; a measure reads results already produced, it never runs an eval
_TARGET = re.compile(r"(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)")
_READING = re.compile(r"(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+(\S.*)")
_CMP = {">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b, "<": lambda a, b: a < b,
        "==": lambda a, b: a == b}  # on Decimal: a float would round 1.0000000000000001 down to 1


_ERR_HEAD = re.compile(r"\s*[\w.]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:")


def _measure(root: Path, cmd: str) -> tuple[Decimal, str] | str:
    """(value, as-of) from the last stdout line `<number> <as-of>`, or why it could not be read."""
    try:
        r = subprocess.run(cmd, shell=True, cwd=root, capture_output=True, text=True,
                           errors="replace", timeout=MEASURE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return f"超时（{MEASURE_TIMEOUT}s）"
    if r.returncode != 0:
        err = r.stderr.strip().splitlines() or [""]
        # first error header (`ValueError: …`, `Error [ERR_X]: …`) beats a runtime footer like "Node.js v26"
        return f"退出码 {r.returncode}：" + next((l for l in err if _ERR_HEAD.match(l)), err[-1]).strip()[:120]
    if "\ufffd" in r.stdout:
        return "输出不是 UTF-8"
    last = (r.stdout.strip().splitlines() or [""])[-1].strip()
    m = _READING.fullmatch(last)
    return (Decimal(m.group(1)), m.group(2)) if m else f"最后一行不是「数值 截至」：{last[:60]!r}"


def _stale(as_of: str, max_days: int) -> str:
    """Why a reading is too old to count (SLO measurement window), or "" when it is fresh."""
    try:
        if not re.match(r"\d{4}-\d\d-\d\d", as_of):
            raise ValueError
        day = _dt.date.fromisoformat(as_of[:10])
    except ValueError:
        return f"测量失败：设了 max_age_days，截至要以 YYYY-MM-DD 开头：{as_of[:30]!r}"
    old = (_dt.date.today() - day).days
    return f"测量过期：截至 {day}，已 {old} 天，超过 {max_days} 天" if old > max_days else ""


def _okr_defs(root: Path) -> list[dict]:
    """The Objectives of root's {OKR_FILE}, validated; a malformed file is refused whole."""
    import tomllib
    path = root / OKR_FILE
    if not path.is_file():
        raise Refused(f"没有 {OKR_FILE}:KR 定义写在仓库里,O 由主人定、KR 由主人点头")
    try:
        objectives = tomllib.loads(path.read_text(encoding="utf-8")).get("objective", [])
    except ValueError as e:  # TOMLDecodeError, UnicodeDecodeError, an integer past int_max_str_digits
        raise Refused(f"{OKR_FILE} 不是合法的 UTF-8 TOML:{e}")
    if not (isinstance(objectives, list) and all(isinstance(o, dict) and isinstance(o.get("kr", []), list)
                                                 and all(isinstance(k, dict) for k in o.get("kr", [])) for o in objectives)):
        raise Refused(f"{OKR_FILE} 要写成 [[objective]] 下挂 [[objective.kr]]")
    for o in objectives:  # a wrong target misreports every run: refuse the file, never skip the KR
        for kr in o.get("kr", []):
            if not isinstance(kr.get("name"), str) or not kr["name"]:
                raise Refused(f"{OKR_FILE}:{o.get('name')} 下有一条 KR 没写 name")
            if not all(isinstance(kr.get(k, ""), str) and "\0" not in kr.get(k, "") for k in ("measure", "unit", "wait")):
                raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr['name']} 的 measure、unit、wait 要写成字符串")
            age = kr.get("max_age_days", 0)
            if isinstance(age, bool) or not isinstance(age, int) or age < 0:
                raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr['name']} 的 max_age_days 要写成非负整数")
            if not isinstance(kr.get("target"), str) or not _TARGET.fullmatch(kr["target"].strip()):
                raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr.get('name')} 的 target 要写成「>= 95」这样")
    return objectives


_AS_OF = re.compile(r"(\d{4}-\d\d-\d\d\S*)\s*(.*)")


def okr_run(root: Path) -> tuple[str, list[tuple[str, float, str, str]], dict[str, bool]]:
    """Each Objective with its KRs measured now; only a measured value meeting its target counts as met.

    Also returns the readings worth keeping, (kr, value, as_of, source), and whether each Objective is all met.
    """
    objectives = _okr_defs(root)
    git = lambda *a: subprocess.run(["git", *a], cwd=root, capture_output=True, text=True).stdout.strip()
    head = git("log", "-1", "--format=%h %cs", "--", OKR_FILE) or "未提交"
    dirty = "（有未提交改动）" if git("status", "--porcelain", "--", OKR_FILE) else ""
    out, readings, full = [f"OKR · 定义 {OKR_FILE} @ {head}{dirty}"], [], {}
    for o in objectives:
        rows, met = [], 0
        for kr in o.get("kr", []):
            op, goal = _TARGET.fullmatch(kr["target"].strip()).groups()
            unit, want = kr.get("unit", ""), f"{op} {goal}{kr.get('unit', '')}"
            got = _measure(root, kr["measure"]) if kr.get("measure") else None
            if isinstance(got, tuple) and (d := _AS_OF.fullmatch(got[1])):
                # ponytail: a dateless as-of is not kept, UNIQUE(as_of, source) would pin its first value forever
                readings.append((kr["name"], float(got[0]), d.group(1), d.group(2)))
            if got is None:
                rows.append(f"  · {kr['name']}  未测 / {want}")
            elif isinstance(got, str):
                rows.append(f"  ! {kr['name']}  测量失败：{got}")
            elif kr.get("max_age_days") is not None and (stale := _stale(got[1], kr["max_age_days"])):
                rows.append(f"  ⌛ {kr['name']}  {got[0]:.1f}{unit} / {want}  {stale}")
            else:
                ok = _CMP[op](got[0], Decimal(goal))
                met += ok
                rows.append(f"  {'✓' if ok else '✗'} {kr['name']}  {got[0]:.1f}{unit} / {want}  截至 {got[1]}")
        out += [f"O {o.get('name')} · {met}/{len(rows)} 达标", *rows]
        full[o.get("name")] = bool(rows) and met == len(rows)
    return "\n".join(out), readings, full


def _now() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


def okr_record(con, repo: Path, readings: list, accept: str | None, full: dict[str, bool]) -> str:
    """Keep the new readings; with accept, the owner's sign-off on an Objective that is all met right now."""
    if accept is not None and not full.get(accept):
        raise Refused(f"没有这个 O:{accept}" if accept not in full else f"{accept} 还没全 ✓,不收 accept")
    now = _now()
    with con:
        n = con.total_changes
        con.executemany("INSERT OR IGNORE INTO kr_readings VALUES (?, ?, ?, ?, ?, ?)",
                        [(str(repo), k, v, as_of, src, now) for k, v, as_of, src in readings])
        n = con.total_changes - n
        if accept is not None:
            con.execute("INSERT INTO okr_accepts VALUES (?, ?, ?)", (str(repo), accept, now))
    return f"读数新记 {n} 条" + (f" · ✓ accept {accept}" if accept is not None else "")


def _closer(op: str, goal: float, prev: float, cur: float) -> str:
    """Whether cur is closer to the target than prev: >= and > want more, <= and < less, == the nearer."""
    dist = {">=": lambda v: -v, ">": lambda v: -v, "<=": lambda v: v, "<": lambda v: v}.get(op, lambda v: abs(v - goal))
    return "closer" if dist(cur) < dist(prev) else "away" if dist(cur) > dist(prev) else "flat"


def okr_data(path: Path | str, repo: Path) -> dict:
    """json okr: the stored readings judged against the current {OKR_FILE}; never runs a measure."""
    objectives = _okr_defs(repo)
    with closing(open_readonly(path)) as con:
        rows = con.execute("SELECT kr, value, as_of, source, measured_at FROM kr_readings WHERE repo=?"
                           " ORDER BY as_of, measured_at", (str(repo),)).fetchall()
        accepts = dict(con.execute("SELECT objective, max(accepted_at) FROM okr_accepts WHERE repo=?"
                                   " GROUP BY objective", (str(repo),)).fetchall())
    by_kr: dict[str, list] = {}
    for r in rows:
        by_kr.setdefault(r["kr"], []).append(r)
    head = subprocess.run(["git", "log", "-1", "--format=%h", "--", OKR_FILE], cwd=repo,
                          capture_output=True, text=True).stdout.strip()
    out = {"repo": str(repo), "def_commit": head or None,
           "last_measured_at": max((r["measured_at"] for r in rows), default=None), "met": 0, "total": 0,
           "objectives": [], "attention": []}
    for o in objectives:
        name, krs, late_miss = o.get("name"), [], False
        for kr in o.get("kr", []):
            op, goal = _TARGET.fullmatch(kr["target"].strip()).groups()
            rs, g = by_kr.get(kr["name"], []), float(goal)
            ok = lambda r: _CMP[op](Decimal(str(r["value"])), Decimal(goal))
            missed = 0
            for r in reversed(rs):
                if ok(r):
                    break
                missed += 1
            last = rs[-1] if rs else None
            if last is None:
                status = "untested"
            elif kr.get("max_age_days") is not None and _stale(last["as_of"], kr["max_age_days"]):
                status = "stale"  # only the latest reading goes stale; history is judged by value
            else:
                status = "missed" if missed else "met"
            trends = [_closer(op, g, a["value"], b["value"]) for a, b in zip(rs, rs[1:])]
            late_miss |= name in accepts and any(r["measured_at"] > accepts[name] and not ok(r) for r in rs)
            krs.append({"name": kr["name"], "target": f"{op} {goal}", "unit": kr.get("unit", ""), "status": status,
                        "value": last and last["value"], "as_of": last and last["as_of"],
                        "source": last and last["source"],
                        "history": [{"value": r["value"], "as_of": r["as_of"]} for r in rs[-3:]],
                        "trend": trends[-1] if trends else None, "missed_rounds": missed, "wait": kr.get("wait")})
            seen = "、".join(f"{r['value']:g}" for r in rs[-3:])
            if status == "missed" and missed >= 5:
                out["attention"].append({"kind": "five", "objective": name, "kr": kr["name"],
                                         "text": f"连续 {missed} 轮未达标（{op} {goal}），最近三次 {seen}"})
            elif status == "missed" and len(trends) >= 2 and "closer" not in trends[-2:]:
                out["attention"].append({"kind": "stuck", "objective": name, "kr": kr["name"],
                                         "text": f"两轮没往目标走（{op} {goal}），最近三次 {seen}"})
            if kr.get("wait") and not kr.get("measure"):
                out["attention"].append({"kind": "wait", "objective": name, "kr": kr["name"], "text": kr["wait"]})
        met = sum(k["status"] == "met" for k in krs)
        pending = bool(krs) and met == len(krs) and (name not in accepts or late_miss)
        if pending:
            out["attention"].append({"kind": "accept", "objective": name, "kr": None,
                                     "text": f"{name} 全 ✓，待你验收（nawaban okr --accept）"})
        out["objectives"].append({"name": name, "met": met, "total": len(krs), "accept_pending": pending, "krs": krs})
        out["met"] += met
        out["total"] += len(krs)
    return out


# ── writes to a GitHub-tracked repository (spec NAWABAN-PROTO) ──

# Each kind's visible prefix is the one people and the older readers already know.
GH_WORDS = {"claim": "认领", "release": "交还", "note": "进展", "decision": "决定", "link": "PR", "ask": "待决", "resolve": "已决"}
# Only a trailing marker counts: a body quoting one stays text. The dumped JSON holds no raw newline.
_MARKER = re.compile(r"\n*<!-- nawaban (\{[^\n]*\}) -->\s*\Z")
_GH_ISSUE = re.compile(r"#(\d+)")


def marker(ev: dict) -> str:
    """The event as an HTML comment; every `-` is escaped so no `--` or `-->` can end it early."""
    import json
    return "<!-- nawaban " + json.dumps(ev, ensure_ascii=False).replace("-", "\\u002d") + " -->"


def read_marker(comment: str) -> dict | None:
    import json
    m = _MARKER.search(comment)
    try:
        return json.loads(m.group(1)) if m else None
    except ValueError:  # someone else's comment ending in a lookalike
        return None


def gh_post(root: Path, number: str, kind: str, body: str, kr: str | None = None) -> None:
    """One comment: the prefixed body for people, then the full event for code."""
    import uuid
    ev = {"v": 1, "uid": str(uuid.uuid4()), "kind": kind, "author": identity(),
          "terminal": herdr_terminal(), "at": int(time.time()), "body": body}
    if kr:
        ev["kr"] = kr
    _gh(root, "issue", "comment", number, "--body", f"{GH_WORDS[kind]}：{body}\n\n{marker(ev)}")


def _role(terminal: str) -> str | None:
    import json
    r = subprocess.run(["hc", "get", terminal, "--json"], capture_output=True, text=True)
    try:
        return (json.loads(r.stdout).get("labels") or {}).get("role") if r.returncode == 0 else None
    except (ValueError, AttributeError):
        return None


def _orchestrator_here() -> bool:
    """True in the terminal the owner labelled role=orchestrator, or for a person at a shell (no Claude session, no Herdr)."""
    # ponytail: a non-Claude agent outside Herdr (Codex with NAWABAN_OWNER) passes as a person; label checks need Herdr
    t = os.environ.get("HC_TERMINAL_ID")
    return _role(t) == "orchestrator" if t else not os.environ.get("CLAUDE_CODE_SESSION_ID")


def repo_orchestrator(root: Path) -> str | None:
    """This terminal if it is the orchestrator, else a live terminal in root's repository (worktrees included) the owner labelled role=orchestrator."""
    import json
    me = os.environ.get("HC_TERMINAL_ID")
    if me and _role(me) == "orchestrator":
        return me
    try:
        ts = json.loads(subprocess.run(["hc", "ls", "--json"], capture_output=True, text=True).stdout)["terminals"]
    except (ValueError, KeyError, TypeError):
        return None
    for t in ts:
        cwd = t.get("cwd")
        if t.get("state") == "live" and cwd and _repo_root(Path(cwd)) == root and _role(t["address"]) == "orchestrator":
            return t["address"]
    return None


def dispatch(root: Path, a, con: sqlite3.Connection | None = None) -> str:
    """A worker in its own worktree off origin/main, briefed with the one report protocol; the ticket records where it runs.
    con is the local board; None means root is GitHub-tracked and the ticket is issue #N."""
    import json
    n = None
    if a.id:
        identity()  # refuse before anything starts
        if con is not None:
            if _task(con, a.id)["status"] != "open":
                raise Refused(f"{a.id} 不是开着的任务")
        else:
            m = _GH_ISSUE.fullmatch(a.id)
            if not m:
                raise Refused(f"GitHub 记账的仓库只接 #N:{a.id}")
            n = m.group(1)
            if _gh_json(root, "issue", "view", n, "--json", "state").get("state") != "OPEN":
                raise Refused(f"{a.id} 不是开着的 issue")
    orch = repo_orchestrator(root)
    if not orch:
        raise Refused("没有活着的编排者(role=orchestrator)可收回报")
    name = a.name or (f"w-{n}" if n else a.id.lower())
    if not re.fullmatch(r"[a-z0-9_-]{1,32}", name):
        raise Refused(f"--name 只能 1-32 个 a-z 0-9 - _:{name}")
    wt, branch = root.parent / f"{root.name}-{name}", f"wt/{name}"
    for cmd in (["fetch", "-q", "origin", "main"], ["worktree", "add", "-q", "-b", branch, str(wt), "origin/main"]):
        r = subprocess.run(["git", "-C", str(root), *cmd], capture_output=True, text=True)
        if r.returncode != 0:
            raise Refused(f"git {cmd[0]} 失败:{r.stderr.strip()}")
    who = a.id or name
    ticket = (f"Issue：{a.id}（认领、进展用 nawaban 命令记，见 docs/agents/issue-tracker.md）" if n else
              f"任务：{a.id}（nawaban show {a.id} 看全文；认领、进展、关闭用 nawaban 命令记）" if a.id else f"任务：{name}")
    brief = "\n".join([
        f"/pstack:poteto-mode {ticket}",
        f"worktree：{wt}（分支 {branch}，已从 origin/main 拉好；只在这里改，PR 合并或作废后 git worktree remove）",
        a.brief,
        f"验收：{a.accept}",
        "完成或受阻：照抄其一，三段位置固定、段里的话自己写，详情记在票上：",
        f'  hc send {orch} "回报：{who} 完成 | 结论一句 | 证据在哪（PR / 票上的记录）"',
        f'  hc send {orch} "回报：{who} 受阻 | 卡在什么 | 要谁做什么"',
    ])
    # a local board the worker must reach even when it was named by --db
    env = ["env", f"NAWABAN_DB={con.execute('PRAGMA database_list').fetchone()[2]}"] if con is not None else []
    r = subprocess.run(["hc", "run", "--bg", "--json", "--name", name, "--cwd", str(wt), *env, "claude", "--model", a.model, brief],
                       capture_output=True, text=True)
    try:
        addr = json.loads(r.stdout)["address"]
    except (ValueError, KeyError, TypeError):
        subprocess.run(["git", "-C", str(root), "worktree", "remove", "--force", str(wt)], capture_output=True)
        subprocess.run(["git", "-C", str(root), "branch", "-D", branch], capture_output=True)
        raise Refused(f"hc run 失败,worktree 已删:{(r.stderr or r.stdout).strip()}")
    if a.id:
        # `dispatch: <name>` opens a local note: the Herdr panel names the task's orchestrator by it
        note = (f"dispatch: {name} · " if con is not None else "") + f"派给 hc {addr}（worktree {wt}，回报给 {orch}）\n验收：{a.accept}"
        try:
            if con is not None:
                add_event(con, a.id, identity(), "note", note)
                con.commit()
            else:
                gh_post(root, n, "note", note)
        except (Refused, OSError, sqlite3.Error) as e:  # the worker runs: say so, and how to record it
            raise Refused(f"已派给 hc {addr}（{wt}），但记票失败:{e}\n补记:nawaban event {shlex.quote(a.id)} --kind note --body {shlex.quote(note)}")
    return f"✓ dispatch {who} → hc {addr} · {wt}"


def gh_write(root: Path, a) -> str:
    """claim / event / close on issue #N of a GitHub-tracked repository."""
    n = _GH_ISSUE.fullmatch(a.id).group(1)
    who = identity()  # refuse before any remote write
    if a.verb == "claim":
        _gh(root, "issue", "edit", n, "--remove-assignee" if a.release else "--add-assignee", "@me")
        if a.release:
            gh_post(root, n, "release", who)
            return f"✓ release {a.id}"
        here = herdr_terminal()
        gh_post(root, n, "claim", who + (f"（hc {here}）" if here else ""))
        return f"✓ claim {a.id}" + (f" · terminal {here}" if here else "")
    if a.verb == "close":
        if a.reopen:
            _gh(root, "issue", "reopen", n)
        else:
            _gh(root, "issue", "close", n, "--reason", "completed" if a.done else "not planned")
        return f"✓ close {a.id} → {'open' if a.reopen else 'done' if a.done else 'cancelled'}"
    if a.kind == "resolve" and not _orchestrator_here():
        raise Refused("已决只由编排者记：主人的拍板转给编排者，或主人在 Herdr 外的终端自己记")
    if a.kind == "ask":
        issue = _gh_json(root, "issue", "view", n, "--json", "body,createdAt,comments")
        if _issue_pending(issue):
            raise Refused(f"{a.id} 已有待决,一个 issue 只放一件;先记已决,或开子 issue")
    gh_post(root, n, a.kind, a.body, a.kr)
    return f"✓ event {a.id} · {a.kind}"


def _canonical(c: dict) -> dict:
    """A comment as the prefix readers see it: a marked one rewritten from its marker, so edits to its visible text do not count."""
    ev = read_marker(c["body"])
    if isinstance(ev, dict) and isinstance(ev.get("body"), str) and GH_WORDS.get(str(ev.get("kind"))):
        return {**c, "body": f"{GH_WORDS[ev['kind']]}：{ev['body']}"}
    return {**c, "body": _MARKER.sub("", c["body"])}  # a malformed marker: read the visible text


def _at(iso: str) -> int:
    return int(_dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())

def _prefixed(comments: list[dict], word: str) -> list[tuple[str, int]]:
    """(body without the prefix, its `（who）` kept, time) of each comment opening with word, oldest first."""
    out = []
    for c in comments:
        m = re.match(_GH_PREFIX.format(word), c["body"])
        if m:
            out.append(((m.group(1) or "") + c["body"][m.end():].strip(), _at(c["createdAt"])))
    return out


def _issue_pending(i: dict) -> dict | None:
    """The latest 待决：/需要你定： line followed by no 已决： line, in the body (raised at its creation) or a comment,
    its text from that line on; with the issue's last PENDING_NOTES 进展, what precedes the line in its comment one of them."""
    found = None
    i = {**i, "comments": [_canonical(c) for c in i["comments"]]}
    for c in [{"body": i.get("body") or "", "createdAt": i["createdAt"]}, *i["comments"]]:
        for k, ln in enumerate(c["body"].splitlines()):
            if _prefixed([{"body": ln, "createdAt": c["createdAt"]}], "(?:待决|需要你定)"):
                found = (c, k)
            elif _prefixed([{"body": ln, "createdAt": c["createdAt"]}], "已决"):
                found = None
    if not found:
        return None
    c, k = found
    lines = c["body"].splitlines()
    notes = _prefixed([{**x, "body": "\n".join(lines[:k])} if x is c else x for x in i["comments"]], "进展")
    return {"brief": "\n".join(lines[k:]), "at": _at(c["createdAt"]),
            "progress": [{"body": b, "at": t} for b, t in notes[-PENDING_NOTES:]]}


def github_board_data(root: Path) -> dict:
    """The same columns as board_data, read from the repository's GitHub issues."""
    # An owner decision says 拍板 or names an owner.
    names = [n.strip() for n in os.environ.get("NAWABAN_OWNER_NAMES", "").split(",") if n.strip()]
    # 「等负责人拍板」「待拍板」 ask for a decision: 等/待, at most a name (an owner's, or up to 4 characters), then 拍板
    waiting = re.compile(r"[等待]\s*(?:%s)?\s*拍板" % "|".join([*map(re.escape, names), r"\w{1,4}?"]))

    def parent_of(i: dict) -> int | None:
        """GitHub's own parent first, else (#N-X) in the title, else 属于 #N / Parent: #N in the body."""
        m = _GH_PARENT_TITLE.search(i["title"]) or _GH_PARENT_BODY.search(i.get("body") or "")
        return i["parent"]["number"] if i.get("parent") else int(m.group(1)) if m else None

    since = time.time() - DECISIONS_RECENT
    tasks, recent = [], []
    for i in _gh_issues(root):
        if i.get("stateReason") == "NOT_PLANNED":
            continue
        cs = [_canonical(c) for c in i["comments"]]
        claims, notes, decisions = (_prefixed(cs, p) for p in ("认领", "进展", "决定"))
        last = [w for c in cs for w in ("认领", "交还") if _prefixed([c], w)][-1:]
        if last == ["交还"]:
            claims = []  # the latest claim was handed back (comment order, not timestamps)
        recent += [{"task": f"#{i['number']}", "at": t, "verdict": _verdict(body),
                    "owner": any(w in waiting.sub("", body) for w in ["拍板", *names])}
                   for body, t in decisions if t >= since]
        # 已决 records the owner's own answer
        recent += [{"task": f"#{i['number']}", "at": t, "verdict": _verdict(body), "owner": True}
                   for body, t in _prefixed(cs, "已决") if t >= since]
        # An assignee holds an issue, whoever assigned it; the latest claim comment names the session.
        holders = [a["login"] for a in i.get("assignees") or []]
        status = "done" if i["state"] == "CLOSED" else "in_progress" if holders else "open"
        parent = parent_of(i)
        terminal = _GH_TERMINAL.search(claims[-1][0]) if claims else None
        task = {
            "id": f"#{i['number']}", "title": i["title"], "status": status, "project": root.name,
            "parent": f"#{parent}" if parent else None,
            # The claimant holds an open issue, as a session holds a board task.
            "session": (claims[-1][0].split("\n", 1)[0] if claims else ", ".join(holders))
                       if status == "in_progress" else None,
            "created_at": _at(i["createdAt"]),
            "active_at": max([_at(i["updatedAt"])] + [_at(c["createdAt"]) for c in cs]),
            "open_blockers": 0, "terminal": terminal.group(1) if terminal else None, "leader": None,
            "claimed_at": claims[0][1] if claims else None, "url": i.get("url")}
        if status == "done":
            task["done_at"] = _at(i["closedAt"])
        else:
            task["progress"] = {"body": notes[-1][0], "at": notes[-1][1]} if notes else None
            task["blocked_by"] = []
            task["waiting"] = None  # GLOSSARY: on GitHub a pending decision takes needs-info's place
            task["decision"] = {"at": decisions[-1][1], "verdict": _verdict(decisions[-1][0])} if decisions else None
            task["pending"] = _issue_pending(i)
        tasks.append(task)
    columns: dict[str, list] = {key: [] for key in COLUMNS}
    for t in sorted(tasks, key=lambda t: -t["active_at"]):
        columns[t["status"]].append(t)
    return {"tracker": "github", "columns": [{"key": k, "tasks": v} for k, v in columns.items()],
            "decisions": sorted(recent, key=lambda d: -d["at"])}


def task_detail(path: Path | str, task_id: str) -> dict:
    with closing(open_readonly(path)) as con:
        t = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if t is None:
            raise Refused(f"任务不存在:{task_id}")
        events = [_event(r) for r in con.execute(
            "SELECT * FROM events WHERE task=? ORDER BY id DESC", (task_id,))]
        parent = con.execute("SELECT * FROM tasks WHERE id=?", (t["parent"],)).fetchone()
        children = con.execute("SELECT * FROM tasks WHERE parent=? ORDER BY id", (task_id,))
        return {
            "id": t["id"], "title": t["title"], "body": t["body"], "status": derived_status(t),
            "project": t["project"], "session": t["session"], "created_at": t["created_at"],
            "parent": _ref(parent) if parent else None,
            "children": [_ref(r) for r in children],
            "blocked_by": [_ref(r) for r in blocked_by(con, task_id)],
            "dependents": [_ref(r) for r in dependents(con, task_id)],
            "latest_note": next((e for e in events if e["kind"] == "note"), None),
            "decisions": [e for e in events if e["kind"] == "decision"],
            "links": [e for e in events if e["kind"] == "link"],
            "events": events,
        }


def any_board(path: Path, project: str | None) -> tuple[dict, str]:
    """json board's data and its name: the repository's GitHub issues when it is GitHub-tracked, else the board."""
    gh = github_root()  # a GitHub-tracked repository has no board: --project is moot there
    return (github_board_data(gh), gh.name) if gh else (board_data(path, project), project or "看板")


def json_out(path: Path, a) -> int:
    """The board as JSON on stdout; an error is {"error": ...} with exit 1."""
    import json
    if a.what == "db":  # the board file itself, links resolved: what a watcher must watch
        print(json.dumps({"db": str(path.resolve())}, ensure_ascii=False))
        return 0
    try:
        if a.what == "projects":
            out = projects_data(path)
        elif a.what == "board":
            out = any_board(path, a.project)[0]
        elif a.what == "okr":
            if not (repo := _repo_root(Path(a.repo or ".").resolve())):
                raise Refused("json okr 要在 git 仓库里跑,或给 --repo")
            out = okr_data(path, repo)
        else:
            out = task_detail(path, a.id)
    except Refused as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


# ── index: the json board as md for a leader (spec NAWABAN-INDEX, format E) ──

STALE = 24 * 3600  # 在推 → 停了 past this long without activity
_BOOKKEEPING = re.compile(r"\s*(?:triage|wayfinder):")  # board notes that are labels, not progress
_MENTION = re.compile(r"(?<![\w.])@([\w-]+)")
_NEXT_SPLIT = re.compile(r"[，,]?\s*下一步[：:]")


def _ago(now: float, at: int) -> str:
    m = int(now - at) // 60
    return f"{m} 分钟" if m < 60 else f"{m // 60} 小时" if m < 48 * 60 else f"{m // 1440} 天"


def _short(text: str, n: int) -> str:
    """One line: links (up to whitespace or CJK/full-width) as (链接), no ** or `, whitespace collapsed, cut at n characters."""
    text = re.sub(r"\s+", " ", re.sub(r"\*\*|`", "", re.sub(r"https?://[^\s\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+", "(链接)", text))).strip()
    return text if len(text) <= n else text[:n] + "…"


def _pending(data: dict) -> list[dict]:
    """The open issues holding a pending decision, oldest first, a tie by issue number."""
    return sorted((t for c in data["columns"] for t in c["tasks"] if t.get("pending")),
                  key=lambda t: (t["pending"]["at"], int(t["id"][1:])))


def _stamp(at: int) -> str:
    return f"{_dt.datetime.fromtimestamp(at):%m-%d %H:%M}"


def brief_text(data: dict) -> str:
    """A leader's raw material for decision cards: each pending decision's text verbatim and its issue's last 进展."""
    if data.get("tracker") != "github":
        raise Refused("brief 只用于 GitHub 记账的仓库(docs/agents/issue-tracker.md 写明 GitHub)")
    pending = _pending(data)
    out = [f"## 待决 {len(pending)}"]
    for t in pending:
        p = t["pending"]
        out += ["", f"### {t['id']} {t['title']} · {_stamp(p['at'])} 提出", t["url"], "原文：", p["brief"],
                "近期进展：" + ("" if p["progress"] else "没有")]
        out += [f"- {_stamp(n['at'])} " + " ".join(n["body"].split()) for n in p["progress"]]
    return "\n".join(out)


def index_text(data: dict, name: str) -> str:
    now = time.time()
    github = data.get("tracker") == "github"  # needs-info no longer waits there: 待决 does, from the text
    tasks = [t for c in data["columns"] for t in c["tasks"]]
    by_id = {t["id"]: t for t in tasks}
    live = [t for t in tasks if t["status"] != "done"]

    def progress(t):
        p = t.get("progress")
        return p if p and not _BOOKKEEPING.match(p["body"]) else None

    def state(t):
        if t.get("waiting") is not None and not github:
            return "等你"
        if progress(t) or t["claimed_at"] or t["session"]:
            return "停了" if now - t["active_at"] > STALE else "在推"
        return "没动"

    def belongs(t):
        if not t["parent"]:
            return ""
        p = by_id.get(t["parent"])  # GitHub lists a closed parent only for 48 hours
        return f" · 属于 {t['parent']}" + (f" {_short(re.sub(r'^\w+:\s*', '', p['title']), 16)}" if p else "")

    groups = {k: sorted((t for t in live if state(t) == k), key=lambda t: t["active_at"])
              for k in (("停了", "在推") if github else ("等你", "停了", "在推"))}
    moving = {t["parent"] for g in groups.values() for t in g}
    idle = sorted((t for t in live if state(t) == "没动" and t["id"] not in moving), key=lambda t: -t["created_at"])
    out = [f"{name} 进行中的事 · {_stamp(now)} 生成",
           " · ".join(f"{k} {len(g)}" for k, g in groups.items()) + f" · 没动 {len(idle)}", ""]
    if github:
        pending = _pending(data)
        out += [f"## 待决 {len(pending)}", *(f"- {t['id']} {_short(t['title'], 200)}" for t in pending), ""]
    for k, g in groups.items():
        if not g:
            continue
        out.append(f"## {k}")
        for t in g:
            p, d = progress(t), t.get("decision")
            if k == "停了":
                mention = _MENTION.search(p["body"]) if p else None
                who = f"@{mention.group(1)}" if mention else "没写"  # 你 is 等你, sorted above
                out.append(f"- {t['id']} {_short(t['title'], 34)}{belongs(t)}"
                           f"（{_ago(now, t['active_at'])}没动静 · 停在：{who}）")
            else:
                out.append(f"- {t['id']} {_short(t['title'], 34)}{belongs(t)}")
            if p:
                out.append(f"  进展 {_ago(now, p['at'])}前：{_short(_NEXT_SPLIT.split(p['body'])[0], 70)}")
            nxt = _GH_NEXT.search(p["body"]) if p else None
            if t.get("waiting") and not github:
                if t["waiting"] != "等你":
                    out.append(f"  下一步：{_short(t['waiting'], 90)}")
            elif nxt and not (d and d["at"] > p["at"]):  # a later decision overtakes the 下一步
                out.append(f"  下一步：{_short(nxt.group(1), 90)}")
            elif d:
                out.append(f"  最近决定 {_ago(now, d['at'])}前：{_short(d['verdict'], 80)}")
        out.append("")
    decided = data.get("decisions", [])
    own = [d for d in decided if d["owner"]]
    out.append(f"## 48 小时内你拍的板 {len(own)}（agent 自己定的另有 {len(decided) - len(own)} 条，在各任务里）")
    out += [f"- {_ago(now, d['at'])}前 {d['task']} {_short(d['verdict'], 70)}" for d in own]
    out += ["", f"## 没动 {len(idle)}（开着，从没认领也没写进展）"]
    out += [f"- {t['id']} {_short(t['title'], 40)}{belongs(t)}" for t in idle]
    # ponytail: the board lists done tasks only as json board keeps them (12 + those of 24 h), so this may undercount there
    closed = sum(1 for t in tasks if t["status"] == "done" and now - (t["done_at"] or 0) < 48 * 3600)
    return "\n".join(out + ["", f"48 小时内关了 {closed} 个。"])


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
    p = sub.add_parser("event", help="记事件:note / decision / link;GitHub 记账的仓库另有 ask(待决)/ resolve(已决)")
    p.add_argument("id")
    p.add_argument("--kind", required=True, choices=("note", "decision", "link", "ask", "resolve"))
    p.add_argument("--body", required=True)
    p.add_argument("--by", choices=("user",), help="user = 用户拍板")
    p.add_argument("--kr", help="挂哪个 Objective / KR;ask 必填,decision 可选")
    p.add_argument("--context", help="ask:只写影响这次决策的事实")
    p.add_argument("--option", action="append", help="ask:每个选项一次,写 trade-off 和 one-way / two-way door;至少两个")
    p.add_argument("--rec", help="ask:Recommendation")
    p = sub.add_parser("show", help="看一个任务")
    p.add_argument("id")
    p = sub.add_parser("list", help="列任务")
    p.add_argument("--project")
    p.add_argument("--parent")
    p.add_argument("--frontier", action="store_true", help="只列可开工:未关闭、没人认领、前置都已关闭")
    p = sub.add_parser("dispatch", help="派 worker(worktree + hc run,回报给编排者),终端号与验收记到票上")
    p.add_argument("id", nargs="?", help="任务号;GitHub 记账的仓库是 #N;不带时只派活不记票(如每晚复盘)")
    p.add_argument("--name", help="终端与 worktree 名,默认 w-<N> 或小写任务号")
    p.add_argument("--brief", required=True, help="目标、范围等派活说明正文")
    p.add_argument("--accept", required=True, help="验收:可检查的完成标准")
    p.add_argument("--model", default="opus")
    sub.add_parser("backup", help="备份到 <看板目录>/backups/ · 保留 14 天")
    p = sub.add_parser("json", help="看板的 JSON(projects、board、task;db:看板文件的真实路径)")
    p.add_argument("what", choices=("projects", "board", "task", "db", "okr"))
    p.add_argument("id", nargs="?", default="", help="task:任务 id")
    p.add_argument("--project", help="board:只看这个项目")
    p.add_argument("--repo", help="okr:仓库路径,默认当前目录所在的仓库")
    sub.add_parser("brief", help="GitHub 记账的仓库:每件待决的原文、所在 issue、该 issue 最近的进展")
    p = sub.add_parser("index", help="等你 / 停了 / 在推的 md 索引(读 json board 同一份数据,只打到 stdout)")
    p.add_argument("--project", help="只看这个项目")
    p = sub.add_parser("okr", help=f"各 O 的 KR 现值对目标:跑 {OKR_FILE} 里每条 KR 的测量,读数记进看板")
    p.add_argument("--accept", metavar="O", help="该 O 当前全 ✓ 时记一次验收")
    return ap


def main(argv: list[str] | None = None) -> int:
    a = _parser().parse_args(argv)
    path = resolve_db(a.db)
    try:
        if a.verb == "init":
            print(f"✓ init → {path}" if init(path) else f"✓ 看板已存在:{path}")
            return 0
        if a.verb == "json":
            return json_out(path, a)
        if a.verb == "okr":
            r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
            if r.returncode != 0:
                raise Refused("okr 要在 git 仓库里跑")
            top = Path(r.stdout.strip())
            text, readings, full = okr_run(top)
            print(text)
            if not path.exists() and a.accept is None:  # no board here: print only, never create one
                print(f"(没有看板 {path},读数没记)", file=sys.stderr)
                return 0
            con = open_board(path)
            try:
                print(okr_record(con, _repo_root(top) or top, readings, a.accept, full))
            finally:
                con.close()
            return 0
        if a.verb == "index":
            print(index_text(*any_board(path, a.project)))
            return 0
        if a.verb == "brief":
            print(brief_text(any_board(path, None)[0]))
            return 0
        if a.verb == "dispatch":
            if not (a.id or a.name):
                raise Refused("不带任务号时要给 --name")
            if root := github_root():
                print(dispatch(root, a))
                return 0
            if not (root := _repo_root(Path.cwd().resolve())):
                raise Refused("dispatch 要在 worker 改的 git 仓库里跑")
            con = open_board(path)
            try:
                print(dispatch(root, a, con))
            finally:
                con.close()
            return 0
        if a.verb in ("claim", "close", "event") and _GH_ISSUE.fullmatch(a.id) and (root := github_root()):
            if a.verb == "event":
                card(a)
            print(gh_write(root, a))
            return 0
        if getattr(a, "kind", None) in ("ask", "resolve"):
            raise Refused("ask / resolve 只用于 GitHub 记账的仓库(#N)")
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
                card(a)
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
