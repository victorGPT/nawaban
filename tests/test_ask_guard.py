"""The ask guard reads only a json#nawaban-ask-request@1 block in an orchestrator's reply; hooks/ask-guard.sh decides who it runs for and hands the rest to nawaban hook ask-guard."""

import json, os, subprocess
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "ask-guard.sh"
NOTHING_LISTENS_HERE = "http://127.0.0.1:9/api/board"
QUESTION = "两条路都能走，A 快 B 稳。你定用哪个？"
BROKEN_BLOCK = '要你定：\n\n```json#nawaban-ask-request@1\n{"ticket": "X-1", "decision": \n```\n'


def _run(tmp_path, message, env, cwd=None, transcript=None):
    r = subprocess.run(["sh", str(HOOK)], env=env, capture_output=True, text=True, timeout=30, input=json.dumps(
        {"session_id": "s", "cwd": str(cwd or tmp_path), "stop_hook_active": False, "transcript_path": transcript,
         "last_assistant_message": message}))
    assert r.returncode == 0 and r.stderr == "", r.stderr
    return json.loads(r.stdout) if r.stdout.strip() else None


def _env(tmp_path, **more):
    env = {k: v for k, v in os.environ.items() if k != "HC_TERMINAL_ID"}
    return {**env, "BOARD_URL": NOTHING_LISTENS_HERE, "NAWABAN_BOARD_DIR": str(tmp_path / "board"), **more}


def _hook(tmp_path, message, role="orchestrator", transcript=None):
    bin_ = tmp_path / "bin"; bin_.mkdir(exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'labels': {'role': role}, 'pid': os.getpid()})}'\n"); (bin_ / "hc").chmod(0o755)
    return _run(tmp_path, message, _env(tmp_path, PATH=f"{bin_}:{os.environ['PATH']}", HC_TERMINAL_ID="t1"), transcript=transcript)


def test_the_orchestrator_asking_in_words_alone_passes(tmp_path):
    assert _hook(tmp_path, QUESTION) is None


def test_the_orchestrator_with_a_broken_block_is_sent_back(tmp_path):
    out = _hook(tmp_path, BROKEN_BLOCK)
    assert out["decision"] == "block" and "nawaban-ask-request@1" in out["reason"]


def test_a_worker_passes_quietly(tmp_path):
    assert _hook(tmp_path, BROKEN_BLOCK, role="worker") is None


def test_no_transcript_is_read_whatever_agent_wrote_it(tmp_path):
    rollout = tmp_path / "rollout.jsonl"
    rollout.write_text(json.dumps({"type": "event_msg", "payload": {"type": "task_started"}}) + "\n")
    agy = tmp_path / "transcript_full.jsonl"
    agy.write_text(json.dumps({"step_index": 0, "type": "USER_INPUT"}) + "\n")
    for transcript in (str(rollout), str(agy), str(tmp_path / "nope.jsonl"), None):
        assert _hook(tmp_path, QUESTION, transcript=transcript) is None, transcript
        assert _hook(tmp_path, BROKEN_BLOCK, transcript=transcript)["decision"] == "block", transcript


def _outside_herdr(tmp_path, declared_session):
    proj = tmp_path / "proj"; proj.mkdir()
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    board = tmp_path / "board"
    if declared_session:
        (board / "orchestrator").mkdir(parents=True)
        (board / "orchestrator" / "proj").write_text(declared_session)
    return _run(tmp_path, BROKEN_BLOCK, _env(tmp_path, NAWABAN_CLI="board"), cwd=proj)


def test_outside_herdr_the_session_declared_orchestrator_is_sent_back(tmp_path):
    assert _outside_herdr(tmp_path, "s")["decision"] == "block"


def test_outside_herdr_another_session_passes(tmp_path):
    assert _outside_herdr(tmp_path, "other") is None


def test_outside_herdr_an_undeclared_project_passes(tmp_path):
    assert _outside_herdr(tmp_path, None) is None
