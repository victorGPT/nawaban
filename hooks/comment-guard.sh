#!/bin/sh
cli="$(cd "$(dirname "$0")/.." && pwd)/nawaban/cli.py"

refuse_state_prefix_typed_into_gh_issue_comment_command_text() {
  CLI="$cli" python3 -c '
import json, os, re, shlex, sys
GH_ISSUE_COMMENT_IN_COMMAND_POSITION = r"(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*gh\s+issue\s+comment\b"
STATE_PREFIX = r"(?:^|[\s\x27\"(=])(?:#{1,6}\s*)?\**(?:认领|进展|待决|已决|决定|需要你定)\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]"
cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
if not re.search(GH_ISSUE_COMMENT_IN_COMMAND_POSITION, cmd, re.M):
    sys.exit(0)
if re.search(STATE_PREFIX, cmd, re.M):
    cli = shlex.quote(os.environ["CLI"])
    print(f"认领、进展、待决、已决、决定由 nawaban 写，评论会带机读标记。改用：\n"
          f"  python3 {cli} claim \x27#N\x27\n"
          f"  python3 {cli} event \x27#N\x27 --kind note|decision|link|ask|resolve --body \"…\"\n"
          f"（note=进展/status update ask=待决/Decision Request resolve=已决/Decision Record decision=决定/Decision Record link=PR；在仓库目录里跑）", file=sys.stderr)
    sys.exit(2)
'
}

refuse_state_prefix_typed_into_gh_issue_comment_command_text
