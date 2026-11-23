#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
. "$hooks/orchestrator.sh"

route=$(node "$hooks/route.mjs" "$(repository_the_session_is_in "$input")" 2>/dev/null)
tracker=${route%% *}
project=${route#* }

show_board_inbox_read_fresh() {
  is_the_orchestrator "$input" "$project" || return 0
  printf '%s' "$input" | node "$hooks/../board/src/cli.ts" inbox --project "$project" 2>/dev/null
}

show_tracker_inbox_from_cache() {
  [ -n "$HC_TERMINAL_ID" ] || return 0
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
