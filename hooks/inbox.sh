#!/bin/sh
[ -n "$HC_TERMINAL_ID" ] || exit 0
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"

session_cwd() {
  cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s' "${cwd:-.}"
}

route=$(node "$hooks/route.mjs" "$(session_cwd)" 2>/dev/null)
tracker=${route%% *}
project=${route#* }

this_terminal_is_the_orchestrator() {
  hc get "$HC_TERMINAL_ID" --json 2>/dev/null | python3 -c '
import json, sys
sys.exit(0 if (json.load(sys.stdin).get("labels") or {}).get("role") == "orchestrator" else 1)' 2>/dev/null
}

show_board_inbox_read_fresh() {
  this_terminal_is_the_orchestrator || return 0
  printf '%s' "$input" | node "$hooks/../board/src/cli.ts" inbox --project "$project" 2>/dev/null
}

show_tracker_inbox_from_cache() {
  printf '%s' "$input" | ROOT="$(cd "$hooks/.." && pwd)" python3 -c '
import json, os, sys
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
if cli._role(os.environ["HC_TERMINAL_ID"]) != "orchestrator":
    sys.exit()
os.chdir(d.get("cwd") or os.getcwd())
line = cli.inbox_line(cli.resolve_db(None), d.get("session_id") or "x")
if line:
    print(json.dumps({"systemMessage": line}, ensure_ascii=False))
' 2>/dev/null
}

if [ "$tracker" = board ]; then
  show_board_inbox_read_fresh
else
  show_tracker_inbox_from_cache
fi
exit 0
