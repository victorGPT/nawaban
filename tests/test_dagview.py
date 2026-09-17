"""The board serves the single-card DAG page and its vendored graph library from the repository."""

import sys
import threading
import types
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("foreman_liveness", types.ModuleType("foreman_liveness"))
from nawaban import board_view  # noqa: E402


@pytest.fixture
def board(tmp_path):
    board_view._Handler.db_path = tmp_path / "missing.db"  # static routes never open the board
    srv = ThreadingHTTPServer(("127.0.0.1", 0), board_view._Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, r.read()


def test_dag_view_is_served(board):
    status, body = _get(board + "/?view=dag&focus=T-1")
    assert status == 200 and b"dagre" in body and b"/api/graph" in body


def test_dag_page_loads_its_vendored_library(board):
    status, body = _get(board + "/vendor/dagre-0.8.5.min.js")
    assert status == 200 and len(body) > 100_000


def test_vendored_library_ships_its_license():
    lic = Path(board_view.DAG_DIR) / "vendor" / "LICENSE.dagre"
    assert "Chris Pettitt" in lic.read_text(encoding="utf-8")


def test_static_files_cannot_escape_through_a_sibling_prefix(board, tmp_path, monkeypatch):
    vendor = tmp_path / "vendor"
    vendor.mkdir()
    secret = tmp_path / "vendor-private" / "marker.txt"
    secret.parent.mkdir()
    secret.write_text("secret")
    monkeypatch.setattr(board_view, "VENDOR_DIR", vendor)
    for rel in (str(secret), "../vendor-private/marker.txt", "%2e%2e/vendor-private/marker.txt"):
        with pytest.raises(urllib.error.HTTPError) as e:
            _get(board + "/vendor/" + rel.lstrip("/") if not rel.startswith("/") else board + "/vendor/" + rel)
        assert e.value.code in (400, 404)
