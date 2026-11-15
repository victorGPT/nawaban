#!/bin/sh
# PreToolUse hook (Bash): issue state is written by nawaban, whose comments carry a machine-readable marker.
# A hand-written `gh issue comment` that opens a line with a state prefix (认领：进展：待决：已决：决定：) is blocked
# and pointed at the command.
# ponytail: matches the command text. --body-file, `gh api` and other programs slip past; the reader still parses unmarked prefixes, so a miss loses only the marker.
cli="$(cd "$(dirname "$0")/.." && pwd)/nawaban/cli.py"
CLI="$cli" python3 -c '
import json, os, re, shlex, sys
cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
# gh in command position: line start, after ; & | ( or $(, past any VAR=value prefixes; not inside a quoted string
if not re.search(r"(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*gh\s+issue\s+comment\b", cmd, re.M):
    sys.exit(0)
if re.search(r"(?:^|[\s\x27\"(=])(?:#{1,6}\s*)?\**(?:认领|进展|待决|已决|决定|需要你定)\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]", cmd, re.M):
    cli = shlex.quote(os.environ["CLI"])
    print(f"认领、进展、待决、已决、决定由 nawaban 写，评论会带机读标记。改用：\n"
          f"  python3 {cli} claim \x27#N\x27\n"
          f"  python3 {cli} event \x27#N\x27 --kind note|decision|link|ask|resolve --body \"…\"\n"
          f"（note=进展 ask=待决 resolve=已决 decision=决定 link=PR；在仓库目录里跑）", file=sys.stderr)
    sys.exit(2)
'
