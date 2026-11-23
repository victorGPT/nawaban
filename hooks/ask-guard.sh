#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
. "$hooks/orchestrator.sh"

route=$(node "$hooks/route.mjs" "$(repository_the_session_is_in "$input")" 2>/dev/null)
project=${route#* }

send_an_unrecorded_ask_back_to_the_tracker() {
  printf '%s' "$input" | ROOT="$(cd "$hooks/.." && pwd)" python3 -c '
import json, os, sys
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
continuing_its_own_block = d.get("stop_hook_active")
if continuing_its_own_block:
    sys.exit()
why = cli.unrecorded_ask(d.get("last_assistant_message") or "", d.get("transcript_path"))
if why:
    print(json.dumps({"decision": "block", "reason": why}, ensure_ascii=False))
' 2>/dev/null
}

is_the_orchestrator "$input" "$project" || exit 0
send_an_unrecorded_ask_back_to_the_tracker
exit 0
