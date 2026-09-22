"""Verify schema and row preservation on a private backup of a selected board.

The source is opened read-only. Only a temporary backup is migrated; no row
values are printed. Repeating initialization must leave that backup unchanged.
"""
import argparse
from collections import Counter
from contextlib import closing
from pathlib import Path
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from urllib.request import urlopen
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import board_view, db  # noqa: E402


def snapshot(path):
    """Read complete SQL definitions and row multisets without writing the board."""
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as con:
        schema = con.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
        tables = [row[1] for row in schema if row[0] == "table"]
        rows = {name: Counter(con.execute('SELECT * FROM "' + name.replace('"', '""') + '"'))
                for name in tables}
        assert con.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert not con.execute("PRAGMA foreign_key_check").fetchall()
        return schema, rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="nawaban-copy-check-") as folder:
        copy = Path(folder) / "board.db"
        with closing(sqlite3.connect(args.source.resolve().as_uri() + "?mode=ro", uri=True)) as source:
            with closing(sqlite3.connect(copy)) as dest:
                source.backup(dest)
        before = snapshot(copy)
        db.migrate_db(copy)
        db.init_db(copy)
        after = snapshot(copy)
        assert after[0] == before[0], "Schema differs from the selected live board"
        assert after[1] == before[1], "Initialization changed existing rows"
        assert db.migrate_db(copy) == []
        db.init_db(copy)
        assert snapshot(copy) == after, "Repeated initialization is not idempotent"
        projects = board_view.projects_data(copy)["projects"]
        for project in projects:
            board_view.board_data(copy, live={}, project=project["name"])
        count = sum(sum(rows.values()) for rows in after[1].values())
        print(f"PASS: {len(after[1])} tables, {count} rows preserved; exact schema parity")
        print(f"PASS: repeated initialization, integrity, foreign keys, {len(projects)} project reads")
        exercise = Path(folder) / "exercise.db"
        with closing(sqlite3.connect(copy)) as source, closing(sqlite3.connect(exercise)) as dest:
            source.backup(dest)
        task_id = "COPY-PROBE-" + uuid4().hex
        project = "copy-probe-" + uuid4().hex
        context = "- A fictional task for database compatibility"
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("NAWABAN_", "WORKOS_", "TYPESAFE_"))}
        env.update(HOME=folder, NAWABAN_OWNER="ac:copy-test", CLAUDE_CODE_SESSION_ID="copy-test")
        command = [sys.executable, str(Path(__file__).resolve().parents[1] / "nawaban/cli.py"),
                   "--db", str(exercise)]
        for arguments in (["create", task_id, "--title", "Copy verification task",
                           "--project", project, "--context", context], ["claim", task_id]):
            result = subprocess.run(command + arguments, env=env, cwd=folder,
                                    capture_output=True, text=True)
            assert result.returncode == 0, "Copy-only CLI fixture failed"
        class Handler(board_view._Handler):
            db_path = exercise
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base + "/api/task?id=" + task_id) as response:
                detail = json.load(response)
            assert detail["context"] == context and "origin" not in detail
            assert detail["status"] == "claimed"
            with urlopen(base + "/api/modules?project=" + project) as response:
                modules = json.load(response)
            assert [task["i"] for task in modules["tasks"]] == [task_id]
            with urlopen(base + "/api/modules?project=missing-" + project) as response:
                assert json.load(response)["tasks"] == []
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        assert snapshot(exercise)[0] == before[0], "CLI changed the current schema"
        assert snapshot(copy) == before, "Fixture writes leaked into the preserved copy"
        with closing(sqlite3.connect(exercise)) as con:
            assert con.execute("SELECT count(*) FROM tasks").fetchone()[0] == sum(before[1]["tasks"].values()) + 1
        print("PASS: isolated create/claim, context detail HTTP API, project filters; baseline rows unchanged")


if __name__ == "__main__":
    main()
