"""Independent idea capture storage; only existing formal tasks can be linked."""
from __future__ import annotations

import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path

from nawaban import db

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 4000),
    project TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','converted','discarded')),
    task_id TEXT REFERENCES tasks(id),
    reason TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT,
    CHECK (
        (status='pending' AND task_id IS NULL AND reason IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
        OR (status='converted' AND task_id IS NOT NULL AND reason IS NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
        OR (status='discarded' AND task_id IS NULL AND length(trim(reason)) > 0 AND reason IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS captures_queue ON captures(status, project, created_at);
CREATE INDEX IF NOT EXISTS captures_task ON captures(task_id);
"""


def validate_text(*values: str) -> None:
    # JSON can contain NUL or lone surrogates, which SQLite/CLI transport cannot carry.
    for value in values:
        if "\x00" in value:
            raise db.NawabanError("捕捉文本不能包含 NUL 字符")
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise db.NawabanError("捕捉文本须为有效 Unicode") from None


def add(path: Path | str, *, content: str, project: str | None, owner: str,
        capture_id: str | None = None) -> dict:
    # CLI and HTTP input are the boundary; the ID also serves as the retry key.
    if not isinstance(content, str) or not 1 <= len(content.strip()) <= 4000:
        raise db.NawabanError("捕捉内容须为 1–4000 字符")
    if project is not None and (not isinstance(project, str) or len(project) > 200):
        raise db.NawabanError("项目须为不超过 200 字符的文本")
    validate_text(content, project or "")
    content, project = content.strip(), (project or None)
    if capture_id is None:
        capture_id = str(uuid.uuid4())
    try:
        valid_id = str(uuid.UUID(capture_id))
    except (ValueError, TypeError, AttributeError):
        raise db.NawabanError("捕捉 ID 须为 UUID") from None
    if capture_id != valid_id:
        raise db.NawabanError("捕捉 ID 须为标准小写 UUID")
    with closing(db.connect(path)) as con, db._txn(con):
        con.row_factory = sqlite3.Row
        previous = con.execute("SELECT * FROM captures WHERE id=?", (capture_id,)).fetchone()
        if previous is not None:
            if (previous["content"], previous["project"], previous["created_by"]) != (content, project, owner):
                raise db.NawabanError("捕捉 ID 已用于其他内容")
            return dict(previous)
        con.execute("INSERT INTO captures(id, content, project, created_at, created_by) VALUES (?,?,?,?,?)",
                    (capture_id, content, project, int(time.time()), owner))
        return dict(con.execute("SELECT * FROM captures WHERE id=?", (capture_id,)).fetchone())


def read(path: Path | str, *, status: str = "pending", project: str | None = None,
         task_id: str | None = None) -> list[dict]:
    if status not in ("pending", "converted", "discarded", "all"):
        raise db.NawabanError("未知捕捉状态")
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)) as con:
        con.row_factory = sqlite3.Row
        # The board is read-only and may serve a database before its first new CLI write.
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='captures'").fetchone():
            return []
        clauses, params = [], []
        if status != "all":
            clauses.append("status=?")
            params.append(status)
        if project is not None:
            clauses.append("COALESCE(project,'')=?")
            params.append(project)
        if task_id is not None:
            clauses.append("task_id=?")
            params.append(task_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        return [dict(r) for r in con.execute(
            "SELECT * FROM captures" + where + " ORDER BY created_at DESC, rowid DESC", params)]


def resolve(path: Path | str, capture_id: str, *, owner: str,
            task_id: str | None = None, reason: str | None = None) -> dict:
    # The CLI chooses one terminal action; reject missing/ambiguous material at persistence.
    if (task_id is None) == (reason is None):
        raise db.NawabanError("转卡与作废必须二选一")
    if reason is not None:
        if not reason.strip():
            raise db.NawabanError("作废原因必填")
        reason = reason.strip()
    validate_text(reason or "", task_id or "")
    status = "converted" if task_id is not None else "discarded"
    with closing(db.connect(path)) as con, db._txn(con):
        con.row_factory = sqlite3.Row
        row = con.execute("SELECT * FROM captures WHERE id=?", (capture_id,)).fetchone()
        if row is None:
            raise db.NawabanError(f"捕捉不存在:{capture_id}")
        if row["status"] != "pending":
            if (row["status"], row["task_id"], row["reason"]) == (status, task_id, reason):
                return dict(row)
            raise db.NawabanError("捕捉已处理,不可改为其他结果")
        if task_id is not None and not con.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
            raise db.NawabanError(f"请先通过正式建卡流程创建任务:{task_id}")
        con.execute("UPDATE captures SET status=?, task_id=?, reason=?, resolved_at=?, resolved_by=? WHERE id=?",
                    (status, task_id, reason, int(time.time()), owner, capture_id))
        return dict(con.execute("SELECT * FROM captures WHERE id=?", (capture_id,)).fetchone())
