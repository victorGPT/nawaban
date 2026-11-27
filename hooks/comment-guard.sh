#!/bin/sh
refuse_state_prefix_typed_into_gh_issue_comment_command_text() {
  python3 -c '
import json, re, sys
GH_ISSUE_COMMENT_IN_COMMAND_POSITION = r"(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*gh\s+issue\s+comment\b"
STATE_PREFIX = r"(?:^|[\s\x27\"(=])(?:#{1,6}\s*)?\**(?:认领|进展|待决|已决|决定|需要你定)\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]"
cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
if not re.search(GH_ISSUE_COMMENT_IN_COMMAND_POSITION, cmd, re.M):
    sys.exit(0)
if re.search(STATE_PREFIX, cmd, re.M):
    print("认领、进展、待决、已决、决定由 nawaban 写，板推到 GitHub 时带机读标记。改用：\n"
          "  nawaban claim <项目>-<N>\n"
          "  nawaban event <项目>-<N> note|decision|link|ask|resolve \"…\"\n"
          "（<项目>-<N> 是 issue #N 在板上的票号，如 ROUBAO-1568；note=进展 ask=待决 resolve=已决 decision=决定 link=PR）", file=sys.stderr)
    sys.exit(2)
'
}

refuse_state_prefix_typed_into_gh_issue_comment_command_text
