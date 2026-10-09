"""Verify that the gate evaluation reports its own noise instead of a bare pass count."""

import importlib.util
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location(
    "gate_eval", Path(__file__).resolve().parents[1] / "scripts/eval_gates.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def runs(variant, passed, total, holdout=False, finished=True, loaded=0):
    return [{"model": "m", "variant": variant, "holdout": holdout, "ok": i < passed,
             "skill_loaded": i < loaded, "finished": finished, "cost_usd": 0.1} for i in range(total)]


def test_interval_matches_known_values_and_handles_no_runs():
    assert evaluation.wilson(17, 18) == pytest.approx((0.742, 0.990), abs=0.001)
    assert evaluation.wilson(0, 3)[0] == 0
    assert evaluation.wilson(3, 3)[1] == 1
    assert evaluation.wilson(0, 0) == (0.0, 1.0)


def test_saturated_cell_points_at_cost_and_overlap_is_called_noise():
    report = evaluation.pooled(runs("old", 17, 18) + runs("new", 18, 18))
    assert "| m | train | new | 18/18 | 0.82-1.00 | 0/18 | 0 | 0.100 (0.000) |" in report
    assert "no headroom" in report
    assert "cannot tell the variants' pass rates apart" in report


def test_clear_difference_with_headroom_gets_no_note():
    report = evaluation.pooled(runs("off", 0, 9) + runs("on", 8, 9))
    assert "no headroom" not in report
    assert "cannot tell" not in report


def test_one_passing_run_is_not_called_saturated():
    assert "no headroom" not in evaluation.pooled(runs("a", 1, 1))


def test_overlapping_intervals_alone_do_not_hide_a_real_difference():
    assert evaluation.two_sided_p((50, 100), (65, 100)) == pytest.approx(0.032, abs=0.001)
    assert "cannot tell" not in evaluation.pooled(runs("a", 50, 100) + runs("b", 65, 100))


def test_splits_are_reported_apart_and_unfinished_runs_are_counted():
    report = evaluation.pooled(runs("a", 2, 4) + runs("a", 1, 2, holdout=True, finished=False, loaded=1))
    assert "| m | train | a | 2/4 |" in report
    assert "| m | holdout | a | 1/2 | 0.09-0.91 | 1/2 | 2 |" in report
