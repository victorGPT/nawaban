"""The semantic title hint warns on low scores and stays silent otherwise."""

import http.client
import io
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# board_view imports a runtime-only module that this snapshot omits
sys.modules.setdefault("foreman_liveness", types.ModuleType("foreman_liveness"))
from workos import cli  # noqa: E402


def _answer(noul):
    def fake_urlopen(req):
        return io.BytesIO(json.dumps({"answers": {"pm_readable": {"noul": noul}}}).encode())
    return fake_urlopen


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")


def test_no_key_skips_the_call(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert cli._title_hint("任意标题") is None


def test_low_score_warns(key, monkeypatch):
    monkeypatch.setattr(cli, "_post", _answer(0.05))
    assert "0.05" in cli._title_hint("迁移 084/086 活导入")


def test_score_at_threshold_is_silent(key, monkeypatch):
    monkeypatch.setattr(cli, "_post", _answer(cli._TITLE_HINT_THRESHOLD))
    assert cli._title_hint("运维面板切开关时不再报错") is None


@pytest.mark.parametrize("failure", [OSError("down"), TimeoutError(),
                                     http.client.IncompleteRead(b"")])
def test_service_failure_is_silent(key, monkeypatch, failure):
    def boom(req):
        raise failure
    monkeypatch.setattr(cli, "_post", boom)
    assert cli._title_hint("任意标题") is None


@pytest.mark.parametrize("payload", [b"{}", b"[]", b"not json",
                                     b'{"answers": {"pm_readable": {"noul": null}}}',
                                     b'{"answers": {"pm_readable": {"noul": "NaN"}}}',
                                     b'{"answers": {"pm_readable": {"noul": -1}}}',
                                     b'{"answers": {"pm_readable": {"noul": false}}}',
                                     b'{"answers": {"pm_readable": {"noul": 1e999}}}',
                                     b'{"answers": {"pm_readable": {"noul": 1' + b"0" * 400 + b'}}}',
                                     b"[" * 5000 + b"]" * 5000])
def test_malformed_response_is_silent(key, monkeypatch, payload):
    monkeypatch.setattr(cli, "_post", lambda req: io.BytesIO(payload))
    assert cli._title_hint("任意标题") is None


def test_redirect_is_not_followed(key, monkeypatch):
    """A 3xx must fail rather than forward the Authorization header."""
    handler = cli._NoRedirect()
    req = cli.urllib.request.Request("https://api.typesafe.ai/x", headers={"Authorization": "Bearer k"})
    assert handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/") is None


def test_opener_failure_is_silent(key, monkeypatch):
    def broken(*handlers):
        raise FileExistsError("SSLKEYLOGFILE")
    monkeypatch.setattr(cli.urllib.request, "build_opener", broken)
    assert cli._title_hint("任意标题") is None
