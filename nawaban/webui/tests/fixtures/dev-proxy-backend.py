"""The real board HTTP handler on a temporary tracker board holding one task."""
import contextlib
import json
import os
import sys
import tempfile
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from nawaban import board_view, cli

board = Path(tempfile.mkdtemp(prefix="nawaban-proxy-")) / "board.db"
os.environ["CLAUDE_CODE_SESSION_ID"] = "proxy-fixture"
with contextlib.redirect_stdout(sys.stderr):  # stdout carries only the ready line
    for args in (["init"], ["create", "PROXY-001", "--title", "Proxy fixture task", "--body", ""]):
        assert cli.main(["--db", str(board), *args]) == 0


class Handler(board_view._Handler):
    db_path = board


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(json.dumps({"port": server.server_port}), flush=True)
server.serve_forever()
