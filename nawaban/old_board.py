"""Read an old-schema board for `nawaban migrate` (spec NAWABAN-LEAN, Migration).

Only reads: the CLI's migrate verb writes what this module returns into a new board.
"""

from __future__ import annotations

import json
import sqlite3

MIGRATOR = "migrate"  # author of events the migration writes itself
TABLES = {"tasks", "task_edges", "task_events", "task_decisions", "task_sessions", "task_refs"}


def _items(raw: str | None) -> list[str]:
    """Old success/constraints: a JSON array, or legacy plain text."""
    if not raw or not raw.strip():
        return []
    try:
        val = json.loads(raw)
    except ValueError:
        return [raw.strip()]
    return [str(v) for v in val if str(v).strip()] if isinstance(val, list) else [str(val)]


def _body(t: sqlite3.Row) -> str:
    parts = [(t["context"] or "").strip()]
    for heading, items in (("Acceptance criteria", _items(t["success"])),
                           ("Constraints", _items(t["constraints_"]))):
        if items:
            parts.append(f"## {heading}\n\n" + "\n".join(f"- {i}" for i in items))
    return "\n\n".join(p for p in parts if p)


def _session(old, t: sqlite3.Row) -> str | None:
    """Claimed and in-progress tasks keep their latest open session; reclaim leaves rows open on other tasks."""
    if t["status"] not in ("claimed", "in_progress"):
        return None
    row = old.execute("SELECT session_id FROM task_sessions WHERE task_id=? AND ended_at IS NULL"
                      " ORDER BY started_at DESC LIMIT 1", (t["id"],)).fetchone()
    if row:
        return row[0]
    # ponytail: no open row → the owner `ac:<session id>` still names the holder.
    return t["owner"].removeprefix("ac:") if t["owner"] else None


def _decision_body(d: sqlite3.Row) -> str:
    lines = [f"问题:{d['question']}", f"结论:{d['verdict']}"]
    try:
        rejected = json.loads(d["rejected"] or "[]")
    except ValueError:
        rejected = [d["rejected"]]
    for r in rejected if isinstance(rejected, list) else [rejected]:
        if isinstance(r, dict):
            r = r.get("option", "") + (f"({r['reason']})" if r.get("reason") else "")
        lines.append(f"否决:{r}")
    if d["adr"]:
        lines.append(f"ADR:{d['adr']}")
    return "\n".join(lines)


def _events(old, t: sqlite3.Row) -> list[tuple]:
    """(at, author, kind, body) in time order; epic/ADR pointers first, staging note and `now` last."""
    tid, at0 = t["id"], t["created_at"]
    head = [(at0, MIGRATOR, "note", f"epic: {t['epic']}")] if t["epic"] else []
    if t["adr"]:
        head.append((at0, MIGRATOR, "link", f"adr:{t['adr']}"))
    evs = []
    for e in old.execute("SELECT * FROM task_events WHERE task_id=? ORDER BY id", (tid,)):
        if e["kind"] == "status_change":
            evs.append((e["created_at"], e["author"], "status", e["body"]))
        else:
            body = e["body"] if e["kind"] == "note" else f"{e['kind']}: {e['body']}"
            evs.append((e["created_at"], e["author"], "note", body))
    for d in old.execute("SELECT * FROM task_decisions WHERE task_id=? ORDER BY id", (tid,)):
        evs.append((d["created_at"], d["decided_by"], "decision", _decision_body(d)))
    for r in old.execute("SELECT * FROM task_refs WHERE task_id=? ORDER BY created_at", (tid,)):
        body = f"{r['kind']}:{r['value']}" + (f" · {r['note']}" if r["note"] else "")
        evs.append((r["created_at"], r["author"] or MIGRATOR, "link", body))
    evs = head + sorted(evs, key=lambda e: e[0])
    last = max([at0] + [e[0] for e in evs])
    if t["status"] == "staging-verified":
        evs.append((last, MIGRATOR, "note", "迁移前状态 staging-verified,新版并入 open"))
    if (t["now"] or "").strip():
        # The old board showed `now` as current progress; as the latest note it stays the progress line.
        evs.append((last, MIGRATOR, "note", t["now"].strip()))
    return evs


def tasks(old) -> list[tuple[dict, list[tuple]]]:
    """Every old task as (new task columns, its events), oldest first."""
    out = []
    for t in old.execute("SELECT * FROM tasks ORDER BY created_at, id").fetchall():
        status = t["status"] if t["status"] in ("done", "cancelled") else "open"
        row = {"id": t["id"], "project": t["project"], "title": t["title"], "body": _body(t),
               "status": status, "session": _session(old, t), "created_at": t["created_at"]}
        out.append((row, _events(old, t)))
    return out


def edges(old) -> list[tuple[str, str, str]]:
    """(kind, src, dst): src is the child (split_from) or the waiting task (depends_on); other kinds drop."""
    return [(e["kind"], e["src"], e["dst"]) for e in old.execute(
        "SELECT src, dst, kind FROM task_edges WHERE kind IN ('split_from','depends_on') ORDER BY created_at")]
