"""Verify that evaluation cannot turn missing labels or late answers into wins."""

import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest


spec = importlib.util.spec_from_file_location(
    "dependency_eval", Path(__file__).resolve().parents[1] / "scripts/eval_dependency_hints.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def test_top_one_and_negative_card_denominators():
    rows = [{"expected": ["a", "b"], "scores": {"a": 1, "b": .94, "c": .99, "d": .98},
             "candidates": ["a", "b", "c", "d"], "seconds": 1},
            {"expected": [], "candidates": ["e"], "scores": {"e": .99}, "seconds": 1},
            {"expected": [], "candidates": ["f"], "scores": {"f": .1}, "seconds": 1}]
    measured = evaluation.metrics(rows, .9)
    assert measured["top1_hints"] == 2
    assert measured["top1_hits"] == 1
    assert measured["top1_precision"] == .5
    assert measured["no_dependency_hint_rate"] == .5
    assert not evaluation.quality_pass(measured)


def test_failed_requests_only_affect_request_success_not_quality_denominators():
    rows = [{"expected": ["a"], "candidates": ["a"], "scores": {"a": 1}, "seconds": 5.01},
            {"expected": ["b"], "candidates": ["b"], "scores": {"b": 1}, "seconds": 1, "error": "HTTPError"},
            {"expected": ["c"], "candidates": ["c"], "scores": {"c": .95}, "seconds": 1},
            {"expected": [], "candidates": ["d"], "scores": {"d": .1}, "seconds": 1}]
    measured = evaluation.metrics(rows, .9)
    assert measured["request_success_rate"] == .5
    assert measured["top1_precision"] == 1
    assert measured["positive_card_hit_rate"] == 1
    assert measured["no_dependency_hint_rate"] == 0
    assert measured["positive_cards"] == 1
    assert evaluation.quality_pass(measured)


def test_candidate_direction_time_and_project():
    target = {"id": "new", "project": "p", "created_at": 100}
    tasks = [{**target, "completed_at": None},
             {"id": "available", "project": "p", "created_at": 90, "completed_at": 110},
             {"id": "finished", "project": "p", "created_at": 80, "completed_at": 99},
             {"id": "future", "project": "p", "created_at": 101, "completed_at": None},
             {"id": "other", "project": "q", "created_at": 50, "completed_at": None}]
    assert [t["id"] for t in evaluation.candidates_for(target, tasks)] == ["available"]


@pytest.mark.parametrize("value", [True, "0.99", None, float("nan"), float("inf"), -1, 2])
def test_bad_api_scores_abstain(value):
    assert evaluation.scores_from({"answers": {"c": {"noul": value}}}, {"c": "task"}) == {}


def test_saved_scores_replay_without_network_and_reject_partial_evidence(tmp_path, monkeypatch):
    data = {"question": evaluation.QUESTION, "gate": evaluation.GATE,
            "thresholds": evaluation.THRESHOLDS, "model": evaluation.MODEL,
            "candidate_rule": evaluation.CANDIDATE_RULE,
            "holdout": [{"id": "target"}]}
    (tmp_path / "snapshot.json").write_text(json.dumps(data))
    (tmp_path / "calibration-decision.json").write_text(json.dumps(
        {"snapshot_sha256": evaluation.digest(data), "threshold": .99,
         "calibration_quality_pass": False}))
    row = {"id": "target", "expected": ["a"], "candidates": ["a", "b"],
           "retained_expected": ["a"],
           "scores": {"a": 1, "b": 0}, "seconds": 1, "payload_bytes": 100}
    path = tmp_path / "holdout.jsonl"
    path.write_text(json.dumps(row) + "\n")
    monkeypatch.setattr(evaluation.subprocess, "run", lambda *a, **kw: pytest.fail("API call during replay"))
    summary = evaluation.evaluate(tmp_path, "holdout", True)
    assert summary["metrics"]["top1_hits"] == 1
    assert not summary["experimental_gate_pass"]
    path.write_text("")
    with pytest.raises(ValueError, match="Incomplete"):
        evaluation.evaluate(tmp_path, "holdout", True)


def test_prepare_keeps_source_unchanged_and_splits_targets_without_overlap(tmp_path):
    path = tmp_path / "board.db"
    with sqlite3.connect(path) as con:
        con.executescript("""
            CREATE TABLE tasks (id TEXT, title TEXT, context TEXT, success TEXT,
                                project TEXT, epic TEXT, status TEXT, created_at INTEGER, completed_at INTEGER);
            CREATE TABLE task_edges (src TEXT, dst TEXT, kind TEXT, created_at INTEGER);
            CREATE TABLE task_events (task_id TEXT, created_at INTEGER);
        """)
        for i in range(181):
            con.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)",
                        (f"t{i:03}", "A visible result", "- Background", "[]", "p", None, "open", i, None))
        for i in range(61, 121):
            con.execute("INSERT INTO task_edges VALUES (?,?,?,?)",
                        (f"t{i:03}", f"t{i - 60:03}", "depends_on", i))
    before = path.read_bytes()
    output = tmp_path / "evaluation"
    output.mkdir()
    evaluation.prepare(path, output)
    assert path.read_bytes() == before
    frozen = (output / "snapshot.json").read_bytes()
    data = json.loads(frozen)
    calibration = {r["id"] for r in data["calibration"]}
    holdout = {r["id"] for r in data["holdout"]}
    assert len(calibration) == 40 and len(holdout) == 80
    assert not calibration & holdout
    for split, positive_count in [("calibration", 20), ("holdout", 40)]:
        assert sum(bool(r["expected"]) for r in data[split]) == positive_count
        assert all(set(r["retained_expected"]) <= set(r["candidates"]) for r in data[split])
        assert all(len(r["candidates"]) <= 25 for r in data[split])
        assert all(set(r["expected"]) == set(r["retained_expected"]) | set(r["discarded_expected"])
                   for r in data[split])
    with pytest.raises(FileExistsError):
        evaluation.prepare(path, output)
    assert (output / "snapshot.json").read_bytes() == frozen


def test_request_excludes_graph_labels_and_task_metadata():
    task = {"id": "private-id", "title": "Visible result", "context": "- Reason", "success": "[]",
            "project": "private-project", "status": "done", "expected": ["label"], "epic": "private-module"}
    payload, names = evaluation.request_payload(task, [{**task, "id": "candidate-id"}])
    encoded = json.dumps(payload)
    for hidden in ["private-id", "candidate-id", "private-project", "private-module", "expected"]:
        assert hidden not in encoded
    assert names == {"candidate_0": "candidate-id"}


def test_shortlist_prefers_epic_and_ignores_future_activity():
    target = {"id": "new", "epic": "module", "created_at": 100}
    tasks = [{"id": f"t{i:02}", "epic": None, "created_at": i} for i in range(30)]
    tasks[0]["epic"] = "module"
    activity = {t["id"]: [t["created_at"]] for t in tasks}
    activity["t01"].extend([90, 200])
    activity["t02"].append(999)
    selected = evaluation.shortlist(target, tasks, activity)
    assert len(selected) == 25
    assert [t["id"] for t in selected[:3]] == ["t00", "t01", "t29"]
    assert "t02" not in {t["id"] for t in selected}
