"""Semantic hints warn on low scores and stay silent otherwise."""

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
    assert cli._hints(title="任意标题") == []


def test_low_score_warns(key, monkeypatch):
    monkeypatch.setattr(cli, "_post", _answer(0.05))
    assert "0.05" in cli._hints(title="迁移 084/086 活导入")[0]


def test_score_at_threshold_is_silent(key, monkeypatch):
    monkeypatch.setattr(cli, "_post", _answer(cli._TITLE_HINT_THRESHOLD))
    assert cli._hints(title="运维面板切开关时不再报错") == []


@pytest.mark.parametrize("failure", [OSError("down"), TimeoutError(),
                                     http.client.IncompleteRead(b"")])
def test_service_failure_is_silent(key, monkeypatch, failure):
    def boom(req):
        raise failure
    monkeypatch.setattr(cli, "_post", boom)
    assert cli._hints(title="任意标题") == []


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
    assert cli._hints(title="任意标题") == []


def test_redirect_is_not_followed(key, monkeypatch):
    """A 3xx must fail rather than forward the Authorization header."""
    handler = cli._NoRedirect()
    req = cli.urllib.request.Request("https://api.typesafe.ai/x", headers={"Authorization": "Bearer k"})
    assert handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/") is None


def test_opener_failure_is_silent(key, monkeypatch):
    def broken(*handlers):
        raise FileExistsError("SSLKEYLOGFILE")
    monkeypatch.setattr(cli.urllib.request, "build_opener", broken)
    assert cli._hints(title="任意标题") == []


def _answers(**nouls):
    body = json.dumps({"answers": {k: {"noul": v} for k, v in nouls.items()}}).encode()
    return lambda req: io.BytesIO(body)


def test_create_judges_title_and_success_in_one_request(key, monkeypatch):
    sent = []

    def fake(req):
        sent.append(json.loads(req.data))
        return _answers(pm_readable=0.9, success_0=0.9, success_1=0.05)(req)
    monkeypatch.setattr(cli, "_post", fake)
    hints = cli._hints("运维面板切开关时不再报错", ["面板上能看到新按钮", "PRAGMA 扫描通过"])
    assert len(sent) == 1
    assert sent[0]["state"] == {"title": "运维面板切开关时不再报错",
                                "success": ["面板上能看到新按钮", "PRAGMA 扫描通过"]}
    assert set(sent[0]["questions"]) == {"pm_readable", "success_0", "success_1"}
    assert len(hints) == 1
    assert "PRAGMA 扫描通过" in hints[0] and "面板上能看到新按钮" not in hints[0]


def test_success_at_threshold_is_silent(key, monkeypatch):
    monkeypatch.setattr(cli, "_post", _answers(success_0=cli._SUCCESS_HINT_THRESHOLD))
    assert cli._hints(success=["面板上能看到新按钮"]) == []


@pytest.mark.parametrize("bad", [{"noul": False}, 5, None, ["x"]])
def test_one_malformed_answer_keeps_the_others(key, monkeypatch, bad):
    body = json.dumps({"answers": {"success_0": bad, "success_1": {"noul": 0.01}}}).encode()
    monkeypatch.setattr(cli, "_post", lambda req: io.BytesIO(body))
    hints = cli._hints(success=["甲", "乙"])
    assert len(hints) == 1 and "乙" in hints[0] and "甲" not in hints[0]


@pytest.mark.parametrize("success", [None, [], [1, None]])
def test_nothing_to_judge_skips_the_call(key, monkeypatch, success):
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert cli._hints(success=success) == []


def test_success_hint_no_key_skips_the_call(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert cli._hints(success=["面板上能看到新按钮"]) == []


def test_huge_score_keeps_the_others(key, monkeypatch):
    body = b'{"answers": {"success_0": {"noul": 1' + b"0" * 400 + b'}, "success_1": {"noul": 0.01}}}'
    monkeypatch.setattr(cli, "_post", lambda req: io.BytesIO(body))
    hints = cli._hints(success=["甲", "乙"])
    assert len(hints) == 1 and "乙" in hints[0]


def test_trickling_response_gives_up_at_the_deadline(key, monkeypatch):
    """A server sending one byte at a time must not hold the command past the deadline."""
    clock = iter(range(1000))
    monkeypatch.setattr(cli.time, "monotonic", lambda: next(clock))

    class Trickle(io.RawIOBase):
        def read(self, n=-1):
            pytest.fail("unbounded read")

        def read1(self, n=-1):
            return b" "

    monkeypatch.setattr(cli, "_post", lambda req: Trickle())
    assert cli._hints(success=["甲"]) == []


def _kind(probs):
    body = json.dumps({"answers": {"evidence_kind": {"type": "choice", "probabilities": probs}}}).encode()
    return lambda req: io.BytesIO(body)


@pytest.mark.parametrize("probs, expect", [
    ({"observed": 0.1, "write_only": 0.9, "none": 0.0}, "写侧信号"),
    ({"observed": 0.1, "write_only": 0.2, "none": 0.7}, "基本是空的"),
])
def test_weak_evidence_warns(key, monkeypatch, probs, expect):
    monkeypatch.setattr(cli, "_post", _kind(probs))
    assert expect in cli._evidence_hint("PR #1 已合并")


@pytest.mark.parametrize("probs", [
    {"observed": 0.8, "write_only": 0.2, "none": 0.0},
    {"observed": 0.5, "write_only": 0.5, "none": 0.0},  # 并列
    {"observed": 0.0, "write_only": 0.5, "none": 0.5},
])
def test_observed_or_tied_evidence_is_silent(key, monkeypatch, probs):
    monkeypatch.setattr(cli, "_post", _kind(probs))
    assert cli._evidence_hint("日志查到 200") is None


@pytest.mark.parametrize("probs", [
    None, [], {"write_only": 1.0},
    {"observed": 0.0, "write_only": True, "none": 0.0},
    {"observed": 0.0, "write_only": 2.0, "none": 0.0},
    {"observed": 0.0, "write_only": 0.9, "none": 0.0, "other": 0.1},
])
def test_malformed_choice_is_silent(key, monkeypatch, probs):
    monkeypatch.setattr(cli, "_post", _kind(probs))
    assert cli._evidence_hint("PR #1 已合并") is None


def test_evidence_hint_no_key_skips_the_call(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert cli._evidence_hint("PR #1 已合并") is None


@pytest.mark.parametrize("kind, calls", [("accept", 1), ("decide", 0)])
def test_only_accept_asks_are_judged(key, monkeypatch, tmp_path, capsys, kind, calls):
    monkeypatch.setenv("WORKOS_DB", str(tmp_path / "w.db"))
    monkeypatch.setenv("FOREMAN_OWNER", "t")
    seen = []
    monkeypatch.setattr(cli, "_evidence_hint", lambda e: seen.append(e) or "提示")
    monkeypatch.setattr(cli, "_hints", lambda *a, **k: [])
    assert cli.main(["init"]) == 0
    assert cli.main(["create", "T-1", "--title", "看板上能看到新按钮"]) == 0
    extra = ["--option", "甲|后果", "--option", "乙|后果"] if kind == "decide" else []
    assert cli.main(["ask", "--kind", kind, "--question", "收下吗", "--evidence", "日志查到 200",
                     "--task", "T-1", *extra]) == 0
    assert len(seen) == calls
    assert ("⚠ 提示" in capsys.readouterr().err) == bool(calls)
