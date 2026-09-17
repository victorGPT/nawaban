"""Codex sessions hit the same main-checkout write gate as Claude Code sessions."""

import subprocess
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.modules.setdefault("foreman_liveness", types.ModuleType("foreman_liveness"))
from nawaban import cli, guard  # noqa: E402


@pytest.fixture
def main_checkout(tmp_path, monkeypatch):
    for key in ("CLAUDE_CODE_SESSION_ID", "FOREMAN_OWNER", "TMUX", "TMUX_PANE", "NAWABAN_DB", "WORKOS_DB"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(guard, "_infer_owner_from_tmux", lambda: None)
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    monkeypatch.chdir(tmp_path)
    assert cli.main(["init"]) == 0
    return tmp_path


def _patch(*headers):
    return "*** Begin Patch\n" + "\n".join(headers) + "\n+x\n*** End Patch"


def _codex(cwd, patch, sid="01a0af31-3246"):  # Codex passes the session only in the payload
    return {"session_id": sid, "cwd": str(cwd), "hook_event_name": "PreToolUse",
            "tool_name": "apply_patch", "tool_input": {"command": patch}}


@pytest.mark.parametrize("header", ["*** Add File: {abs}", "*** Update File: {abs}",
                                    "*** Delete File: {abs}", "*** Add File: notes/y.txt"])
def test_apply_patch_into_main_checkout_is_blocked(main_checkout, header):
    code, msg = guard.judge(_codex(main_checkout, _patch(header.format(abs=main_checkout / "y.txt"))))
    assert code == 2 and "worktree gate" in msg and "apply_patch" in msg


def test_move_target_in_main_checkout_is_blocked(main_checkout, tmp_path_factory):
    outside = tmp_path_factory.mktemp("elsewhere") / "a.txt"
    patch = _patch(f"*** Update File: {outside}", f"*** Move to: {main_checkout / 'b.txt'}")
    assert guard.judge(_codex(main_checkout, patch))[0] == 2


def test_apply_patch_outside_main_checkout_passes(main_checkout, tmp_path_factory):
    outside = tmp_path_factory.mktemp("elsewhere") / "y.txt"
    assert guard.judge(_codex(main_checkout, _patch(f"*** Add File: {outside}"))) == (0, "")


def test_board_files_stay_writable(main_checkout):
    assert guard.judge(_codex(main_checkout, _patch("*** Add File: .nawaban/note.txt")))[0] == 0


def test_no_session_anywhere_stays_a_no_op(main_checkout):
    payload = _codex(main_checkout, _patch(f"*** Add File: {main_checkout / 'y.txt'}"), sid="")
    assert guard.judge(payload) == (0, "")


def test_codex_merge_command_uses_payload_session(main_checkout):
    payload = {"session_id": "01a0af31", "cwd": str(main_checkout), "tool_name": "Bash",
               "tool_input": {"command": "gh pr merge 1 --squash && echo done"}}
    assert guard.judge(payload)[0] == 2


def test_environment_session_still_wins(main_checkout, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "abcdef12-0000")
    assert guard.resolve_owner("01a0af31-3246") == "ac:abcdef12"
    monkeypatch.delenv("CLAUDE_CODE_SESSION_ID")
    assert guard.resolve_owner("01a0af31-3246") == "ac:01a0af31"


def test_indented_patch_header_is_still_a_target(main_checkout):
    # Codex trims patch lines before reading headers
    patch = f"*** Begin Patch\n  *** Add File: {main_checkout / 'y.txt'}\n+x\n*** End Patch"
    assert guard.judge(_codex(main_checkout, patch))[0] == 2


def test_added_content_that_looks_like_a_header_is_ignored(main_checkout, tmp_path_factory):
    outside = tmp_path_factory.mktemp("elsewhere") / "y.txt"
    patch = f"*** Begin Patch\n*** Add File: {outside}\n+*** Add File: {main_checkout / 'z.txt'}\n*** End Patch"
    assert guard.judge(_codex(main_checkout, patch)) == (0, "")


def test_tilde_is_a_literal_directory_under_cwd(main_checkout, monkeypatch, tmp_path_factory):
    # apply_patch does not expand ~, so ~/y.txt lands in <cwd>/~/y.txt
    monkeypatch.setenv("HOME", str(tmp_path_factory.mktemp("home")))
    assert guard.judge(_codex(main_checkout, _patch("*** Add File: ~/y.txt")))[0] == 2
