"""NAWABAN-AGENTS-07: hooks/agy.mjs turns Antigravity hook input, recorded from agy 1.5.15, into the Claude Code shape our scripts read, and maps their replies back."""

import json, os, shutil, subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "agy"
TRANSCRIPT = FIXTURES / "transcript_full.jsonl"
CONVERSATION = "4234b2f6-f445-44ec-99b9-874a44a00d51"
LAST_STEP_OF_THE_QUESTION = 13
NOTHING_LISTENS_HERE = "http://127.0.0.1:9/api/board"
BROKEN_ASK_BLOCK = '要你定：\n\n```json#nawaban-ask-request@1\n{"ticket": "AGY-01", "decision": \n```\n'


def recorded(name, **overrides):
    return {**json.loads((FIXTURES / name).read_text()), **overrides}


def run(plugin_root, event, payload, env=None):
    r = subprocess.run(["node", str(plugin_root / "hooks" / "agy.mjs"), event], input=payload if isinstance(payload, str) else json.dumps(payload),
                       capture_output=True, text=True, timeout=60, env={**os.environ, **(env or {})})
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


SAYS_WHAT_IT_GOT = """python3 -c 'import json,sys; d=json.load(sys.stdin); print("prompt=%s session=%s cwd=%s cmd=%s" % (d["prompt"], d["session_id"], d["cwd"], d["tool_input"]["command"]))'"""
ASK_GUARD_ECHOING_THE_REPLY = """python3 -c 'import json,sys; d=json.load(sys.stdin); d.get("stop_hook_active") or print(json.dumps({"decision": "block", "reason": "退回：" + d["last_assistant_message"]}))'"""
REFUSES_FORBIDDEN = """python3 -c 'import json,sys; c=json.load(sys.stdin)["tool_input"]["command"]; ("forbidden" in c) and (print("不许", file=sys.stderr) or sys.exit(2))'"""


def stub_plugin(tmp_path):
    root = tmp_path / "plugin"; (root / "hooks").mkdir(parents=True)
    shutil.copy(ROOT / "hooks" / "agy.mjs", root / "hooks" / "agy.mjs")
    hook = lambda command: {"hooks": [{"type": "command", "command": command}]}
    (root / "hooks" / "hooks.json").write_text(json.dumps({"hooks": {
        "SessionStart": [hook("echo 现状索引")],
        "UserPromptSubmit": [hook(SAYS_WHAT_IT_GOT)],
        "PreToolUse": [hook(REFUSES_FORBIDDEN)],
        "PostToolUse": [hook("true")],
        "Stop": [hook('echo \'{"systemMessage": "待决 1 件"}\' # inbox.sh'), hook(ASK_GUARD_ECHOING_THE_REPLY)],
    }}))
    return root


def injected(answer):
    return answer["injectSteps"][0]["systemMessage"]["systemMessage"]


def test_the_first_model_call_of_a_prompt_gets_the_prompt_hooks_and_the_pending_line(tmp_path):
    text = injected(run(stub_plugin(tmp_path), "PreInvocation", recorded("PreInvocation-declare.json")))
    assert f"prompt=/nawaban:orchestrator session={CONVERSATION}" in text and "待决 1 件" in text


def test_later_model_calls_of_the_same_prompt_inject_nothing(tmp_path):
    assert run(stub_plugin(tmp_path), "PreInvocation", recorded("PreInvocation-later-call.json")) == {}


def test_session_start_output_is_injected(tmp_path):
    assert injected(run(stub_plugin(tmp_path), "SessionStart", recorded("SessionStart.json"))) == "现状索引"


def test_an_empty_cwd_falls_back_to_the_first_workspace(tmp_path):
    text = injected(run(stub_plugin(tmp_path), "PreInvocation", recorded("PreInvocation-declare.json", cwd="", workspacePaths=["/w/one", "/w/two"])))
    assert "cwd=/w/one" in text


def test_a_command_is_allowed_unless_a_hook_exits_2_and_then_denied_with_its_reason(tmp_path):
    plugin = stub_plugin(tmp_path)
    call = recorded("PreToolUse.json")
    assert run(plugin, "PreToolUse", call) == {"decision": "allow"}
    call["toolCall"]["args"]["CommandLine"] = "echo forbidden"
    assert run(plugin, "PreToolUse", call) == {"decision": "deny", "reason": "不许"}


def test_unreadable_input_or_hooks_file_still_allows_the_command(tmp_path):
    plugin = stub_plugin(tmp_path)
    assert run(plugin, "PreToolUse", "not json") == {"decision": "allow"}
    (plugin / "hooks" / "hooks.json").unlink()
    assert run(plugin, "PreToolUse", recorded("PreToolUse.json")) == {"decision": "allow"}


def test_a_blocked_stop_continues_with_the_reason_built_from_the_last_reply_in_the_transcript(tmp_path):
    answer = run(stub_plugin(tmp_path), "Stop", recorded("Stop.json", transcriptPath=str(TRANSCRIPT)))
    assert answer == {"decision": "continue", "reason": "退回：AGY-01 有 A（快）和 B（稳）两条路，你选哪个？"}


def test_a_stop_after_a_continue_is_let_through_though_continuation_active_stays_false(tmp_path):
    stop = recorded("Stop-continued.json", transcriptPath=str(TRANSCRIPT))
    assert stop["continuationActive"] is False and stop["executionNum"] == 1
    assert run(stub_plugin(tmp_path), "Stop", stop) == {}


def declared_project(tmp_path, parent=None):
    proj = (parent or tmp_path) / "agyws"; proj.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main", str(proj)], check=True)
    board = tmp_path / "board"
    env = {"NAWABAN_CLI": "board", "NAWABAN_BOARD_DIR": str(board), "NAWABAN_BOARD_PORT": "9", "BOARD_URL": NOTHING_LISTENS_HERE, "HC_TERMINAL_ID": ""}
    return proj, board, env


def test_typing_the_declaration_in_agy_records_the_conversation_as_orchestrator(tmp_path):
    proj, board, env = declared_project(tmp_path)
    answer = run(ROOT, "PreInvocation", recorded("PreInvocation-declare.json", cwd=str(proj)), env)
    assert (board / "orchestrator" / "agyws").read_text() == CONVERSATION
    assert f"已把会话 {CONVERSATION} 记为 agyws 的编排者" in injected(answer)


def test_an_agy_file_write_by_the_declared_orchestrator_is_denied_and_a_command_still_runs(tmp_path, outside_tmp):
    proj, board, env = declared_project(tmp_path, outside_tmp)
    (board / "orchestrator").mkdir(parents=True); (board / "orchestrator" / "agyws").write_text(CONVERSATION)
    env = {**env, "TMPDIR": str(tmp_path / "scratch")}
    call = recorded("PreToolUse.json", cwd=str(proj))
    write = {**call, "toolCall": {"name": "write_to_file", "args": {"TargetFile": str(proj / "a.py")}}}
    answer = run(ROOT, "PreToolUse", write, env)
    assert answer["decision"] == "deny" and "nawaban dispatch" in answer["reason"]
    assert run(ROOT, "PreToolUse", call, env)["decision"] == "allow"


def test_the_ask_guard_sends_back_a_broken_ask_block_and_lets_a_question_in_words_through(tmp_path):
    proj, board, env = declared_project(tmp_path)
    (board / "orchestrator").mkdir(parents=True); (board / "orchestrator" / "agyws").write_text(CONVERSATION)
    steps = [json.loads(l) for l in TRANSCRIPT.read_text().splitlines()][:LAST_STEP_OF_THE_QUESTION + 1]
    steps[-1]["content"] = BROKEN_ASK_BLOCK
    replied_a_broken_block = tmp_path / "t.jsonl"
    replied_a_broken_block.write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in steps))
    sent_back = run(ROOT, "Stop", recorded("Stop.json", cwd=str(proj), transcriptPath=str(replied_a_broken_block)), env)
    assert sent_back["decision"] == "continue" and "nawaban-ask-request@1" in sent_back["reason"]
    assert run(ROOT, "Stop", recorded("Stop.json", cwd=str(proj), transcriptPath=str(TRANSCRIPT)), env) == {}
    assert run(ROOT, "Stop", recorded("Stop-continued.json", cwd=str(proj), transcriptPath=str(replied_a_broken_block)), env) == {}


def test_the_comment_guard_denies_a_hand_written_state_comment(tmp_path):
    call = recorded("PreToolUse.json")
    call["toolCall"]["args"]["CommandLine"] = "gh issue comment 9 --body '进展：测试'"
    answer = run(ROOT, "PreToolUse", call)
    assert answer["decision"] == "deny" and "由 nawaban 写" in answer["reason"]
