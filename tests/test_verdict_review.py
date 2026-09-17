"""The import report lists decisions whose attribution the semantic check disputes, without changing them."""

import io
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# runtime-only modules this snapshot omits
sys.modules.setdefault("foreman_liveness", types.ModuleType("foreman_liveness"))
_card = types.ModuleType("foreman_card")
_card.CardError, _card.parse_card_text = Exception, None
sys.modules.setdefault("foreman_card", _card)
from workos import cli, import_md  # noqa: E402


def _plan(*verdicts):
    decisions = [{"verdict": v, "decided_by": by,
                  "provenance": {"file": "t.md", "line": i + 1}}
                 for i, (v, by) in enumerate(verdicts)]
    return import_md.CardPlan(task_id="T-1", path="t.md", row={}, decisions=decisions)


def _choices(*probs):
    body = json.dumps({"answers": {f"d{i}": {"type": "choice", "probabilities": p}
                                   for i, p in enumerate(probs)}}).encode()
    return lambda req: io.BytesIO(body)


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")


def test_disagreements_are_listed_and_decisions_untouched(key, monkeypatch):
    plan = _plan(("用户:只看挂设备", "agent:x"), ("拍板做", "agent:x"), ("保留用户否决权", "user"))
    monkeypatch.setattr(cli, "_post", _choices({"user": 0.9, "agent": 0.1},
                                               {"user": 0.1, "agent": 0.9},
                                               {"user": 0.2, "agent": 0.8}))
    review = import_md.verdict_review([plan])
    assert [(r["line"], r["rule"], r["model"]) for r in review["rows"]] == [
        (1, "agent", "user"), (3, "user", "agent")]
    assert review["unjudged"] == 0
    assert [d["decided_by"] for d in plan.decisions] == ["agent:x", "agent:x", "user"]


def test_one_request_per_card(key, monkeypatch):
    sent = []

    def fake(req):
        sent.append(json.loads(req.data))
        return _choices({"user": 0.1, "agent": 0.9}, {"user": 0.1, "agent": 0.9})(req)
    monkeypatch.setattr(cli, "_post", fake)
    import_md.verdict_review([_plan(("甲", "agent:x"), ("乙", "agent:x")), _plan()])
    assert len(sent) == 1 and len(sent[0]["questions"]) == 2


@pytest.mark.parametrize("probs", [None, {"user": 0.5, "agent": 0.5}, {"user": True, "agent": 0.0},
                                   {"user": 0.9}, {"user": 0.9, "agent": 0.1, "x": 0.0}])
def test_unusable_answers_are_counted_not_guessed(key, monkeypatch, probs):
    monkeypatch.setattr(cli, "_post", _choices(probs))
    review = import_md.verdict_review([_plan(("甲", "agent:x"))])
    assert review == {"rows": [], "unjudged": 1}


def test_service_failure_counts_every_row_as_unjudged(key, monkeypatch):
    def boom(req):
        raise OSError("down")
    monkeypatch.setattr(cli, "_post", boom)
    assert import_md.verdict_review([_plan(("甲", "agent:x"), ("乙", "user"))]) == {"rows": [], "unjudged": 2}


def test_no_key_skips_review_and_report_says_so(monkeypatch):
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert import_md.verdict_review([_plan(("甲", "agent:x"))]) is None
    report = import_md.render_report(Path("."), [], [], [], [], None, [], None)
    assert "未设 TYPESAFE_API_KEY" in report


def test_report_lists_rows_and_unjudged_count():
    review = {"rows": [{"task_id": "T-1", "file": "t.md", "line": 3, "rule": "agent",
                        "model": "user", "p": 0.92, "verdict": "用户:只看挂设备"}], "unjudged": 2}
    report = import_md.render_report(Path("."), [], [], [], [], None, [], review)
    assert "相左 1 条" in report and "未拿到合法判分 2 条" in report
    assert "`T-1` t.md:3 · 规则=agent · 语义=user(0.92)" in report
