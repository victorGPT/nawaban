"""The board serves frontend assets without allowing paths outside its static root."""

import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import board_view  # noqa: E402


@pytest.fixture
def board(tmp_path):
    board_view._Handler.db_path = tmp_path / "missing.db"  # static routes never open the board
    srv = ThreadingHTTPServer(("127.0.0.1", 0), board_view._Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return r.status, r.read()


def test_frontend_assets_and_favicon_are_served(board, tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "assets/app.js").write_text("window.app = true;")
    (dist / "favicon.svg").write_text("<svg></svg>")
    monkeypatch.setattr(board_view, "WEBUI_DIST", dist)
    assert _get(board + "/assets/app.js") == (200, b"window.app = true;")
    assert _get(board + "/favicon.svg") == (200, b"<svg></svg>")


def test_static_files_cannot_escape_through_a_sibling_prefix(board, tmp_path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    secret = tmp_path / "dist-private/marker.txt"
    secret.parent.mkdir()
    secret.write_text("secret")
    (dist / "assets/link").symlink_to(secret.parent, target_is_directory=True)
    (dist / "favicon.svg").symlink_to(secret)
    monkeypatch.setattr(board_view, "WEBUI_DIST", dist)
    for route in (
        "/assets/../../dist-private/marker.txt",
        "/assets/%2e%2e/%2e%2e/dist-private/marker.txt",
        "/assets/link/marker.txt",
        "/favicon.svg",
    ):
        with pytest.raises(urllib.error.HTTPError) as error:
            _get(board + route)
        assert error.value.code in (400, 404)


def test_legacy_board_has_no_single_card_graph_entry():
    assert "view=dag" not in board_view.PAGE
    assert '<kbd>g</kbd>' not in board_view.PAGE
    assert 'if(e.key==="g"' not in board_view.PAGE


def test_retired_vendor_route_is_unavailable(board):
    with pytest.raises(urllib.error.HTTPError) as error:
        _get(board + "/vendor/dagre-0.8.5.min.js")
    assert error.value.code == 404
