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
from collections import Counter
from contextlib import closing
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
    return {"columns": [{"key": k, "tasks": v} for k, v in columns.items()]}


# ── json board from GitHub issues (spec NAWABAN-INDEX, Data mapping) ──

GH_RECENT = 48 * 3600  # closed issues stay this long
_GH_FIELDS = "number,title,state,stateReason,closedAt,createdAt,updatedAt,labels,body,comments"
_GH_PARENT_TITLE = re.compile(r"[(（]#(\d+)-[A-Za-z]+[)）]")  # (#236-B)
_GH_PARENT_BODY = re.compile(r"(?:属于|Part of|Parent:)\s*#(\d+)")
_GH_TERMINAL = re.compile(r"\bhc (t\w+)")  # 认领：gh-275（hc t52）
_GH_NEXT = re.compile(r"下一步：\s*([^。\n]+)")  # the sentence after it


def github_root(cwd: Path | None = None) -> Path | None:
    """The repository cwd is in, when its docs/agents/issue-tracker.md's first heading names GitHub."""
    root = _repo_root((cwd or Path.cwd()).resolve())
    try:
        lines = (root / "docs" / "agents" / "issue-tracker.md").read_text().splitlines() if root else []
    except OSError:
        return None
    heading = next((ln for ln in lines if ln.startswith("#")), "")
    return root if "GitHub" in heading else None


def _gh_issues(root: Path) -> list[dict]:
    """Open issues plus those closed in the last GH_RECENT seconds, as `gh issue list --json` gives them."""
    import json
    since = _dt.datetime.fromtimestamp(time.time() - GH_RECENT, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out: list[dict] = []
    for state in (["--state", "open"], ["--state", "closed", "--search", f"closed:>={since}"]):
        try:
            r = subprocess.run(["gh", "issue", "list", *state, "--limit", "1000", "--json", _GH_FIELDS],
                               cwd=root, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            raise Refused(f"gh 不可用:{e}") from e
        if r.returncode != 0:
            raise Refused(f"gh 失败:{r.stderr.strip()}")
        out += json.loads(r.stdout)
    return out


def github_board_data(root: Path) -> dict:
    """The same columns as board_data, read from the repository's GitHub issues."""
    def at(iso: str) -> int:
        return int(_dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())

    def prefixed(comments: list[dict], prefix: str) -> list[tuple[str, int]]:
        """(body without the prefix, time) of each comment opening with prefix, oldest first."""
        return [(c["body"][len(prefix):].strip(), at(c["createdAt"])) for c in comments
                if c["body"].startswith(prefix)]

    tasks = []
    for i in _gh_issues(root):
        if i.get("stateReason") == "NOT_PLANNED":
            continue
        cs = i["comments"]
        claims, notes, decisions = (prefixed(cs, p) for p in ("认领：", "进展：", "决定："))
        status = "done" if i["state"] == "CLOSED" else "in_progress" if claims else "open"
        parent = _GH_PARENT_TITLE.search(i["title"]) or _GH_PARENT_BODY.search(i["body"])
        terminal = _GH_TERMINAL.search(claims[-1][0]) if claims else None
        task = {
            "id": f"#{i['number']}", "title": i["title"], "status": status, "project": root.name,
            "parent": f"#{parent.group(1)}" if parent else None,
            # The claimant holds an open issue, as a session holds a board task.
            "session": claims[-1][0].split("\n", 1)[0] if claims and status != "done" else None,
            "created_at": at(i["createdAt"]),
            "active_at": max([at(i["updatedAt"])] + [at(c["createdAt"]) for c in cs]),
            "open_blockers": 0, "terminal": terminal.group(1) if terminal else None, "leader": None,
            "claimed_at": claims[0][1] if claims else None}
        if status == "done":
            task["done_at"] = at(i["closedAt"])
        else:
            task["progress"] = {"body": notes[-1][0], "at": notes[-1][1]} if notes else None
            task["blocked_by"] = []
            nxt = _GH_NEXT.search(notes[-1][0]) if notes else None
            task["waiting"] = ((nxt.group(1) if nxt else "等你")
                               if any(lb["name"] == "needs-info" for lb in i["labels"]) else None)
            task["decision"] = {"at": decisions[-1][1], "verdict": _verdict(decisions[-1][0])} if decisions else None
        tasks.append(task)
    columns: dict[str, list] = {key: [] for key in COLUMNS}
    for t in sorted(tasks, key=lambda t: -t["active_at"]):
        columns[t["status"]].append(t)
    return {"columns": [{"key": k, "tasks": v} for k, v in columns.items()]}


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
            gh = github_root()  # a GitHub-tracked repository has no board: --project is moot there
            out = github_board_data(gh) if gh else board_data(path, a.project)
        else:
            out = task_detail(path, a.id)
    except Refused as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


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
    p = sub.add_parser("json", help="看板的 JSON(projects、board、task;db:看板文件的真实路径)")
    p.add_argument("what", choices=("projects", "board", "task", "db"))
    p.add_argument("id", nargs="?", default="", help="task:任务 id")
    p.add_argument("--project", help="board:只看这个项目")
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
