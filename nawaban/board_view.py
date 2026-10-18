#!/usr/bin/env python3
"""nawaban board: a local read-only web page over a tracker board (spec NAWABAN-LEAN, Board).

Run: python3 nawaban/board_view.py [--db PATH] [--port 8813] [--host 127.0.0.1]

GET /api/projects, /api/board and /api/task?id= are the whole API. The board opens the
file read-only and answers every write method with 405, so the page cannot change tasks.
"In progress" is derived (a session holds an open task), as in the tracker CLI.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import sys
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import tracker  # noqa: E402
from nawaban.paths import web_dist  # noqa: E402

WEBUI_DIST = web_dist()
COLUMNS = ("open", "in_progress", "done")
DONE_LIMIT = 12  # Without a date range the done column shows only the latest few.


class BoardError(Exception):
    """The board file is missing or is not a tracker board."""


class NotFound(Exception):
    pass


# ── read-only projections ─────────────────────────────────────────

def _ro(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    if not path.exists():
        raise BoardError(f"看板不存在:{path}")
    if tracker._version(path) != tracker.VERSION:
        raise BoardError(f"不是新版看板:{path}")
    con = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def _status(r: sqlite3.Row) -> str:
    return "in_progress" if r["status"] == "open" and r["session"] else r["status"]


def _ref(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "title": r["title"], "status": _status(r)}


def _event(r: sqlite3.Row) -> dict:
    return {"kind": r["kind"], "body": r["body"], "author": r["author"], "at": r["at"]}


def range_bounds(since: str, until: str) -> tuple[int, int]:
    """'YYYY-MM-DD' ends in local time, until inclusive → [lo, hi) epoch. Raises ValueError."""
    lo = datetime.strptime(since, "%Y-%m-%d")
    hi = datetime.strptime(until, "%Y-%m-%d") + timedelta(days=1)
    if hi <= lo:
        raise ValueError("until 早于 since")
    return int(lo.timestamp()), int(hi.timestamp())


def projects_data(path: Path | str) -> dict:
    con = _ro(path)
    try:
        rows = con.execute(
            "SELECT NULLIF(project,'') AS name, SUM(status='open') AS open, count(*) AS total"
            " FROM tasks GROUP BY name ORDER BY name IS NULL, name").fetchall()
        return {"projects": [dict(r) for r in rows]}
    finally:
        con.close()


def board_data(path: Path | str, project: str | None = None,
               touched: tuple[int, int] | None = None) -> dict:
    """Tasks in three columns, latest activity first. project "" = tasks without a project."""
    sql = ("SELECT t.*, MAX(COALESCE(e.at, t.created_at)) AS active_at,"
           " (SELECT count(*) FROM blockers b JOIN tasks x ON x.id=b.blocker"
           "  WHERE b.task=t.id AND x.status='open') AS open_blockers"
           " FROM tasks t LEFT JOIN events e ON e.task=t.id WHERE t.status!='cancelled'")
    args: dict = {}
    if project is not None:
        sql += " AND COALESCE(t.project,'')=:project"
        args["project"] = project
    if touched:
        sql += (" AND (t.created_at >= :lo AND t.created_at < :hi OR EXISTS (SELECT 1 FROM"
                " events x WHERE x.task=t.id AND x.at >= :lo AND x.at < :hi))")
        args["lo"], args["hi"] = touched
    con = _ro(path)
    try:
        rows = con.execute(sql + " GROUP BY t.id ORDER BY active_at DESC, t.id", args).fetchall()
    finally:
        con.close()
    columns = {key: [] for key in COLUMNS}
    for r in rows:
        columns[_status(r)].append({
            "id": r["id"], "title": r["title"], "status": _status(r), "project": r["project"],
            "parent": r["parent"], "session": r["session"], "created_at": r["created_at"],
            "active_at": r["active_at"], "open_blockers": r["open_blockers"]})
    if not touched:
        columns["done"] = columns["done"][:DONE_LIMIT]
    return {"columns": [{"key": k, "tasks": v} for k, v in columns.items()]}


def task_detail(path: Path | str, task_id: str) -> dict:
    con = _ro(path)
    try:
        t = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if t is None:
            raise NotFound(f"任务不存在:{task_id}")

        def tasks(sql: str) -> list[dict]:
            return [_ref(r) for r in con.execute(sql + " ORDER BY t.id", (task_id,))]

        events = [_event(r) for r in con.execute(
            "SELECT * FROM events WHERE task=? ORDER BY id DESC", (task_id,))]
        parent = con.execute("SELECT * FROM tasks WHERE id=?", (t["parent"],)).fetchone()
        return {
            "id": t["id"], "title": t["title"], "body": t["body"], "status": _status(t),
            "project": t["project"], "session": t["session"], "created_at": t["created_at"],
            "parent": _ref(parent) if parent else None,
            "children": tasks("SELECT t.* FROM tasks t WHERE t.parent=?"),
            "blocked_by": tasks("SELECT t.* FROM blockers b JOIN tasks t ON t.id=b.blocker WHERE b.task=?"),
            "dependents": tasks("SELECT t.* FROM blockers b JOIN tasks t ON t.id=b.task WHERE b.blocker=?"),
            "latest_note": next((e for e in events if e["kind"] == "note"), None),
            "decisions": [e for e in events if e["kind"] == "decision"],
            "links": [e for e in events if e["kind"] == "link"],
            "events": events,
        }
    finally:
        con.close()


# ── HTTP ─────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    db_path: Path = Path()

    def _send(self, code: int, body: bytes, ctype: str, headers: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj, headers: dict | None = None) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8", headers)

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        arg = lambda k: (qs.get(k) or [""])[0]  # noqa: E731
        project = "" if arg("unassigned") == "1" else arg("project") or None
        try:
            if u.path == "/":
                index = WEBUI_DIST / "index.html"
                if index.is_file():
                    self._send(200, index.read_bytes(), "text/html; charset=utf-8")
                else:
                    self._send(503, "网页还没构建:npm --prefix nawaban/webui ci && npm --prefix"
                               " nawaban/webui run build\n".encode(), "text/plain; charset=utf-8")
            elif u.path == "/api/projects":
                self._json(200, projects_data(self.db_path))
            elif u.path == "/api/board":
                touched = None
                if arg("since"):
                    try:
                        touched = range_bounds(arg("since"), arg("until") or arg("since"))
                    except ValueError:
                        self._json(400, {"error": "since/until 须为 YYYY-MM-DD 且 until ≥ since"})
                        return
                self._json(200, board_data(self.db_path, project, touched))
            elif u.path == "/api/task":
                self._json(200, task_detail(self.db_path, arg("id")))
            elif u.path.startswith("/assets/") or u.path == "/favicon.svg":
                self._static(WEBUI_DIST, unquote(u.path.lstrip("/")))
            else:
                self._json(404, {"error": "no such path"})
        except NotFound as e:
            self._json(404, {"error": str(e)})
        except BoardError as e:
            self._json(503, {"error": str(e)})

    def _refuse_write(self) -> None:
        self._json(405, {"error": "看板只读:改任务用 nawaban CLI"}, {"Allow": "GET"})

    do_POST = do_PUT = do_PATCH = do_DELETE = _refuse_write  # noqa: N815

    def _static(self, root: Path, rel: str) -> None:
        if ".." in rel.split("/") or rel.startswith("/"):
            self._json(400, {"error": "bad path"})
            return
        fp = (root / rel).resolve()
        if not fp.is_relative_to(root.resolve()) or not fp.is_file():
            self._json(404, {"error": "no such static file"})
            return
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        if fp.suffix == ".js":
            ctype = "application/javascript"
        self._send(200, fp.read_bytes(), ctype)

    def log_message(self, fmt: str, *args) -> None:
        pass  # A local read-only page; nobody reads the access log.


def serve(path: Path, port: int, host: str = "127.0.0.1") -> None:
    """Serve on each comma-separated host (loopback plus the own tailnet IP, for a phone).

    The board has no authentication, so it never binds every interface.
    """
    _Handler.db_path = path
    hosts = [h.strip() for h in host.split(",") if h.strip()]
    if any(h in ("0.0.0.0", "::", "*") for h in hosts):  # noqa: S104
        print("✗ 拒绝绑 0.0.0.0:板无鉴权,只许绑 127.0.0.1 与自己的 tailnet IP",
              file=sys.stderr)
        raise SystemExit(2)
    servers = [ThreadingHTTPServer((h, port), _Handler) for h in hosts]
    for h in hosts:
        print(f"NAWABAN 板 → http://{h}:{port}/  (库:{path} · 只读)")
    for srv in servers[:-1]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    servers[-1].serve_forever()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="board_view", description="NAWABAN 本地只读板")
    ap.add_argument("--db", help="看板文件(默认 NAWABAN_DB,再找最近的 .nawaban/nawaban.db)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("NAWABAN_BOARD_PORT") or "8813"))
    ap.add_argument("--host", default=(os.environ.get("NAWABAN_BOARD_HOST")
                                     or os.environ.get("DAGVIEW_HOST", "127.0.0.1")),
                    help="监听地址,逗号分隔可给多个(如 127.0.0.1,100.x.x.x)")
    a = ap.parse_args(argv)
    path = tracker.resolve_db(a.db)
    try:
        _ro(path).close()
    except BoardError as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1
    serve(path, a.port, host=a.host)
    return 0


if __name__ == "__main__":
    sys.exit(main())
