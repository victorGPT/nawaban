"""Verify that the skill-trigger evaluation grades load order and keeps its held-out cases fixed."""

import importlib.util
import json
from pathlib import Path


spec = importlib.util.spec_from_file_location(
    "trigger_eval", Path(__file__).resolve().parents[1] / "scripts/eval_skill_trigger.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def transcript(*calls):
    return "\n".join(json.dumps({"message": {"content": [{"type": "tool_use", "name": name, "input": tool_input}]}})
                     for name, tool_input in calls) + "\nnot json\n"


def test_skill_counts_as_first_only_before_an_acting_tool():
    load = ("Skill", {"skill": "nawaban:nawaban"})
    assert evaluation.fired(transcript(("Read", {}), load, ("Edit", {}))) == (True, True)
    assert evaluation.fired(transcript(("Edit", {}), load)) == (False, True)
    assert evaluation.fired(transcript(("Bash", {}), ("Skill", {"skill": "pr"}))) == (False, False)
    assert evaluation.fired("") == (False, False)
    denied = json.dumps({"type": "system", "subtype": "permission_denied", "message": "needs approval"})
    assert evaluation.fired(denied + "\n" + transcript(load)) == (True, True)


def test_a_session_that_never_ran_cannot_pass():
    assert not evaluation.score("", "palindrome", False, "v", "sonnet", 0, "train")["ok"]
    done = json.dumps({"type": "result", "is_error": False, "total_cost_usd": 0.1})
    assert evaluation.score(done, "palindrome", False, "v", "sonnet", 0, "train")["ok"]


def test_transcript_names_keep_hyphenated_models_and_skip_unscored_cases():
    expects = {"named_card_edit": True, "named": True, "card_status": None}
    assert evaluation.parse_name("named_card_edit-base-claude-sonnet-5-5-2", expects) == (
        "named_card_edit", "base", "claude-sonnet-5-5", 2)
    assert evaluation.parse_name("named_card_edit-v1-opus-0", expects) == ("named_card_edit", "v1", "opus", 0)
    assert evaluation.parse_name("card_status-base-opus-0", expects) is None
    assert evaluation.parse_name("gone-base-opus-0", expects) is None


def test_held_out_cases_are_stable_and_cover_both_kinds():
    held = evaluation.test_ids()
    assert held == evaluation.test_ids()
    kinds = [expect for case, expect, _, _ in evaluation.CASES if case in held]
    assert (len(kinds) - kinds.count(False), kinds.count(False)) == (7, 4)
    assert len({case for case, *_ in evaluation.CASES}) == len(evaluation.CASES)


def test_summary_scores_each_kind_by_its_own_rule_and_lists_cases():
    row = {"split": "train", "variant": "v", "model": "m", "finished": True, "denied": 1, "gates": 2, "cost_usd": 0.1}
    results = [row | {"case": "a", "expect": True, "early": True, "late": True, "ok": True},
               row | {"case": "a", "expect": True, "early": False, "late": True, "ok": False},
               row | {"case": "b", "expect": False, "early": False, "late": False, "ok": True}]
    assert "| m | train | v | 2 | 2/3 | 0.21-0.94 | 1/2 | 1/1 | 2.00 | 0 | 3 | 0.100 |" in evaluation.summarise(results)
    assert "| m | v | a | yes | 1/2 | 1 |" in evaluation.by_case(results)
