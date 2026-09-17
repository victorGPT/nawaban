"""HTTP write trust boundaries reject browser forgery before invoking the CLI."""
import http.client
import json
import socket
import subprocess
import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from nawaban import board_view, db

_DEFAULT_BODY = object()
_REAL_RUN = subprocess.run


@pytest.fixture(params=[socket.AF_INET, socket.AF_INET6], ids=["ipv4", "ipv6"])
def board(request, monkeypatch, tmp_path):
    class Server(ThreadingHTTPServer):
        address_family = request.param

    class Handler(board_view._Handler):
        db_path = tmp_path / "unopened.db"

    address = "::1" if request.param == socket.AF_INET6 else "127.0.0.1"
    server = Server((address, 0), Handler)
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout="answer committed", stderr="")

    monkeypatch.setattr(board_view.subprocess, "run", run)
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    yield SimpleNamespace(server=server, address=address, port=server.server_address[1], calls=calls)
    server.shutdown()
    server.server_close()
    thread.join()


def post(board, *, host=None, origin="same", content_type="application/json", body=_DEFAULT_BODY,
         extra=(), path="/api/answer"):
    authority = host if host is not None else f"localhost:{board.port}"
    conn = http.client.HTTPConnection(board.address, board.port, timeout=3)
    payload = json.dumps({"ask_id": 1, "verdict": "approved"} if body is _DEFAULT_BODY else body).encode()
    conn.putrequest("POST", path, skip_host=True)
    if authority:
        conn.putheader("Host", authority)
    if content_type is not None:
        conn.putheader("Content-Type", content_type)
    if origin is not None:
        conn.putheader("Origin", "http://" + authority if origin == "same" else origin)
    for name, value in extra:
        conn.putheader(name, value)
    conn.putheader("Content-Length", str(len(payload)))
    conn.endheaders(payload)
    response = conn.getresponse()
    result = response.status, json.loads(response.read())
    conn.close()
    return result


@pytest.mark.parametrize("media", [None, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])
def test_simple_cross_site_requests_never_reach_cli(board, media):
    status, _ = post(board, origin="https://attacker.invalid", content_type=media)
    assert status == 415
    assert board.calls == []


@pytest.mark.parametrize("origin", ["null", "https://attacker.invalid", "http://localhost:1", "http://127.0.0.1:1"])
def test_cross_origin_json_is_rejected(board, origin):
    assert post(board, origin=origin)[0] == 403
    assert board.calls == []


@pytest.mark.parametrize("host", ["", "attacker.invalid", "localhost.attacker.invalid", "localhost:1", "127.0.0.1:1", "0.0.0.0:1", "[::]:1"])
def test_host_must_name_listener_at_actual_port(board, host):
    assert post(board, host=host)[0] == 403
    assert board.calls == []


@pytest.mark.parametrize("name", ["localhost", "127.0.0.1", "[::1]"])
def test_matching_loopback_browser_origin_reaches_cli_once(board, name):
    status, result = post(board, host=f"{name}:{board.port}", content_type="application/json; charset=utf-8")
    assert status == 200 and result["ok"]
    assert len(board.calls) == 1
    command, options = board.calls[0]
    assert command[-4:] == ["answer", "1", "--verdict", "approved"]
    assert options["env"]["FOREMAN_OWNER"] == "inbox"


def test_local_cli_without_origin_is_allowed(board):
    assert post(board, origin=None)[0] == 200
    assert len(board.calls) == 1


def test_origin_must_match_host_even_for_two_local_aliases(board):
    assert post(board, host=f"localhost:{board.port}", origin=f"http://127.0.0.1:{board.port}")[0] == 403
    assert board.calls == []


def test_cross_site_fetch_metadata_is_rejected_without_origin(board):
    assert post(board, origin=None, extra=[("Sec-Fetch-Site", "cross-site")])[0] == 403
    assert board.calls == []


@pytest.mark.parametrize("name,value", [("Host", "attacker.invalid"), ("Origin", "null"), ("Content-Type", "text/plain")])
def test_ambiguous_security_headers_are_rejected(board, name, value):
    assert post(board, extra=[(name, value)])[0] in (403, 415)
    assert board.calls == []


def test_listener_address_is_allowed_with_matching_origin(board):
    # Model a second bound interface while keeping the HTTP test transport local.
    board.server.server_address = ("100.64.0.7", board.port)
    assert post(board, host=f"100.64.0.7:{board.port}")[0] == 200
    assert len(board.calls) == 1


def test_nonlocal_host_requires_origin(board):
    board.server.server_address = ("100.64.0.7", board.port)
    assert post(board, host=f"100.64.0.7:{board.port}", origin=None)[0] == 403
    assert board.calls == []


@pytest.mark.parametrize("body", [None, [], True, {"ask_id": 1, "verdict": None}, {"ask_id": 1, "verdict": ["approved"]}])
def test_malformed_answer_material_never_reaches_cli(board, body):
    assert post(board, body=body)[0] == 400
    assert board.calls == []


def test_cli_timeout_is_unknown_and_is_not_retried(board, monkeypatch):
    def timeout(command, **kwargs):
        board.calls.append((command, kwargs))
        raise subprocess.TimeoutExpired(command, 30)

    monkeypatch.setattr(board_view.subprocess, "run", timeout)
    status, result = post(board)
    assert status == 504
    assert result["unknown"] is True
    assert "别重试" in result["out"]
    assert len(board.calls) == 1


def test_cli_rejection_is_reported_without_retry(board, monkeypatch):
    def reject(command, **kwargs):
        board.calls.append((command, kwargs))
        return SimpleNamespace(returncode=1, stdout="", stderr="ask already closed")

    monkeypatch.setattr(board_view.subprocess, "run", reject)
    status, result = post(board)
    assert status == 400 and result["ok"] is False
    assert "already closed" in result["out"]
    assert len(board.calls) == 1


def test_remote_cli_without_origin_cannot_use_local_host(board, monkeypatch):
    handler = board.server.RequestHandlerClass
    setup = handler.setup

    def remote_setup(self):
        setup(self)
        self.client_address = ("100.64.0.8", self.client_address[1])

    monkeypatch.setattr(handler, "setup", remote_setup)
    assert post(board, origin=None)[0] == 403
    assert board.calls == []


@pytest.mark.parametrize("wildcard", ["0.0.0.0", "::"])
def test_wildcard_listener_metadata_does_not_trust_arbitrary_host(board, wildcard):
    board.server.server_address = (wildcard, board.port)
    assert post(board, host=f"attacker.invalid:{board.port}")[0] == 403
    authority = f"[{wildcard}]" if ":" in wildcard else wildcard
    assert post(board, host=f"{authority}:{board.port}")[0] == 403
    assert board.calls == []


def test_same_origin_answer_commits_and_closed_ask_cannot_be_answered_twice(board, monkeypatch):
    path = board.server.RequestHandlerClass.db_path
    db.init_db(path)
    db.create_task(path, task_id="T-HTTP", title="Allow the demo change")
    ask_id = db.raise_ask(path, kind="authorize", question="Allow this demo change?",
                         evidence="Reviewed the local artifact", task_ids=["T-HTTP"],
                         raised_by="ac:test")
    monkeypatch.setattr(board_view.subprocess, "run", _REAL_RUN)
    body = {"ask_id": ask_id, "verdict": "Approved from the test browser"}
    assert post(board, body=body)[0] == 200
    assert db.ask_detail(path, ask_id)["closed_as"] == "answered"
    with db.connect(path) as con:
        assert con.execute("SELECT status FROM tasks WHERE id='T-HTTP'").fetchone()[0] == "open"
        assert con.execute("SELECT count(*) FROM task_decisions").fetchone()[0] == 1
    assert post(board, body=body)[0] == 400
    with db.connect(path) as con:
        assert con.execute("SELECT count(*) FROM task_decisions").fetchone()[0] == 1


@pytest.mark.parametrize("address", ["fe80::1%lo0", "::1%lo0"])
@pytest.mark.parametrize("origin,expected", [(None, 403), ("same", 200)])
@pytest.mark.parametrize("scope_parser", ["native", "reject"])
def test_scoped_ipv6_peer_requires_origin(board, monkeypatch, address, origin, expected, scope_parser):
    handler = board.server.RequestHandlerClass
    setup = handler.setup

    def scoped_setup(self):
        setup(self)
        # Represent the scoped peer metadata returned by an IPv6 socket.
        self.client_address = (address, self.client_address[1], 0, 1)

    monkeypatch.setattr(handler, "setup", scoped_setup)
    if scope_parser == "reject":
        native_parse = board_view.ipaddress.ip_address

        def reject_scope(value):
            # Represent runtimes/parsers that reject scoped address strings.
            if "%" in value:
                raise ValueError("Scoped address is not accepted")
            return native_parse(value)

        monkeypatch.setattr(board_view.ipaddress, "ip_address", reject_scope)
    assert post(board, origin=origin)[0] == expected
    assert len(board.calls) == (1 if expected == 200 else 0)
