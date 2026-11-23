"""NAWABAN-INBOX-02: a reply asking the decision-maker to decide, with no ask recorded this turn, is sent back."""

import json, os, subprocess
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "ask-guard.sh"
ASK = "nawaban event '#7' --kind ask --body 定 A 还是 B --kr K --context c --option A --option B --rec A"


def _transcript(tmp_path, *commands, earlier=()):
    """A JSONL transcript: an earlier turn running earlier, then the user's prompt, then this turn running commands."""
    def turn(prompt, cmds):
        yield {"type": "user", "message": {"role": "user", "content": prompt}}
        for k, c in enumerate(cmds):
            yield {"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": f"u{k}", "name": "Bash", "input": {"command": c}}]}}
            yield {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"u{k}", "content": "ok"}]}}
    p = tmp_path / "t.jsonl"
    p.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in [*turn("先前", earlier), *turn("继续", commands)]) + "\n")
    return str(p)


def _hook(tmp_path, message, transcript, role="orchestrator", active=False):
    bin_ = tmp_path / "bin"; bin_.mkdir(exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'labels': {'role': role}, 'pid': os.getpid()})}'\n"); (bin_ / "hc").chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1"}
    r = subprocess.run(["sh", str(HOOK)], env=env, capture_output=True, text=True, timeout=10, input=json.dumps(
        {"session_id": "s", "cwd": str(tmp_path), "stop_hook_active": active, "transcript_path": transcript,
         "last_assistant_message": message}))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout) if r.stdout.strip() else None


QUESTION = "两条路都能走，A 快 B 稳。你定用哪个？"


def test_asking_in_chat_without_an_ask_is_sent_back(tmp_path):
    out = _hook(tmp_path, QUESTION, _transcript(tmp_path, "ls"))
    assert out["decision"] == "block" and "--kind ask" in out["reason"]
    assert _hook(tmp_path, "这个要你点头：先合 #85。", _transcript(tmp_path))["decision"] == "block"


def test_an_ask_recorded_this_turn_lets_it_through(tmp_path):
    assert _hook(tmp_path, QUESTION, _transcript(tmp_path, "ls", ASK)) is None
    board = "nawaban event T-1 --kind note --body 'triage: needs-info — 等你：用哪个'"
    assert _hook(tmp_path, QUESTION, _transcript(tmp_path, board)) is None


def test_searching_for_the_words_is_not_recording(tmp_path):
    assert _hook(tmp_path, QUESTION, _transcript(tmp_path, 'rg "triage: needs-info" skills'))["decision"] == "block"


def test_an_ask_from_an_earlier_turn_does_not_count(tmp_path):
    assert _hook(tmp_path, QUESTION, _transcript(tmp_path, "ls", earlier=[ASK]))["decision"] == "block"


def test_no_question_passes(tmp_path):
    for msg in ("PR 已合并，你定的 A 方案已上线。", "测试全过，要不要看日志都行。", "做完了。"):
        assert _hook(tmp_path, msg, _transcript(tmp_path)) is None, msg


def test_a_continuation_after_a_block_passes(tmp_path):
    assert _hook(tmp_path, QUESTION, _transcript(tmp_path), active=True) is None


def test_a_worker_or_a_missing_transcript_passes_quietly(tmp_path):
    assert _hook(tmp_path, QUESTION, _transcript(tmp_path), role="worker") is None
    assert _hook(tmp_path, QUESTION, str(tmp_path / "nope.jsonl")) is None  # unreadable: never hold the session


def test_quoted_or_split_ask_arguments_count(tmp_path):
    for cmd in ('nawaban event 7 --kind "ask" --body x', "nawaban event 7 --kind=ask --body x",
                json.dumps('nawaban event 7 --kind "ask" --body x')):  # a command quoted inside REPL code
        assert _hook(tmp_path, QUESTION, _transcript(tmp_path, cmd)) is None, cmd
    p = tmp_path / "r.jsonl"  # a Code Mode REPL call passing the arguments as an array
    p.write_text("\n".join(json.dumps(x) for x in [
        {"type": "user", "message": {"content": "go"}},
        {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "REPL",
            "input": {"code": "await $`nawaban ${['event', '#7', '--kind', 'ask']}`"}}]}}]))
    assert _hook(tmp_path, QUESTION, str(p)) is None


def _codex_rollout(tmp_path, *calls, earlier=()):
    """A Codex rollout: each turn opens with task_started; a tool call is a response_item whose payload type ends in _call."""
    def turn(cmds):
        yield {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "x"}}
        yield {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "继续"}]}}
        for c in cmds:
            yield {"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec",
                   "input": f"text(await tools.exec_command({json.dumps({'cmd': c})}))"}}
            yield {"type": "response_item", "payload": {"type": "custom_tool_call_output", "output": "ok"}}
    p = tmp_path / "rollout.jsonl"
    p.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in [*turn(earlier), *turn(calls)]) + "\n")
    return str(p)


def test_a_codex_rollout_is_read_turn_by_turn(tmp_path):
    assert _hook(tmp_path, QUESTION, _codex_rollout(tmp_path, "ls", ASK)) is None
    assert _hook(tmp_path, QUESTION, _codex_rollout(tmp_path, "ls"))["decision"] == "block"
    assert _hook(tmp_path, QUESTION, _codex_rollout(tmp_path, "ls", earlier=[ASK]))["decision"] == "block"
    p = tmp_path / "fn.jsonl"
    p.write_text("\n".join(json.dumps(x) for x in [
        {"type": "event_msg", "payload": {"type": "task_started"}},
        {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command",
            "arguments": json.dumps({"cmd": "nawaban event X-1 --kind note --body 'triage: needs-info — 等你：用哪个'"})}}]))
    assert _hook(tmp_path, QUESTION, str(p)) is None


def _outside_herdr(tmp_path, declared_session):
    proj = tmp_path / "proj"; proj.mkdir()
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    board = tmp_path / "board"
    if declared_session:
        (board / "orchestrator").mkdir(parents=True)
        (board / "orchestrator" / "proj").write_text(declared_session)
    env = {k: v for k, v in os.environ.items() if k != "HC_TERMINAL_ID"}
    env.update(NAWABAN_CLI="board", NAWABAN_BOARD_DIR=str(board))
    r = subprocess.run(["sh", str(HOOK)], env=env, capture_output=True, text=True, timeout=10, input=json.dumps(
        {"session_id": "s", "cwd": str(proj), "stop_hook_active": False,
         "transcript_path": _codex_rollout(tmp_path, "ls"), "last_assistant_message": QUESTION}))
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout) if r.stdout.strip() else None


def test_outside_herdr_the_session_declared_orchestrator_is_sent_back(tmp_path):
    assert _outside_herdr(tmp_path, "s")["decision"] == "block"


def test_outside_herdr_another_session_passes(tmp_path):
    assert _outside_herdr(tmp_path, "other") is None


def test_outside_herdr_an_undeclared_project_passes(tmp_path):
    assert _outside_herdr(tmp_path, None) is None
