"""Isolated real board HTTP handler with a recording CLI stub; never opens a DB."""
import json
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))
from nawaban import board_view

requests = []
calls = []


def run(command, **kwargs):
    calls.append(command)
    return SimpleNamespace(returncode=0, stdout="review fixture", stderr="")


board_view.subprocess.run = run


class Handler(board_view._Handler):
    db_path = Path("unused-proxy-fixture.db")

    def do_POST(self):
        requests.append(dict(self.headers))
        super().do_POST()

    def do_GET(self):
        if self.path == "/api/review-requests":
            self._json(200, {"requests": requests, "calls": len(calls)})
        else:
            super().do_GET()


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(json.dumps({"port": server.server_port}), flush=True)
server.serve_forever()
