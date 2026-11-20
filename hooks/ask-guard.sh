#!/bin/sh
# Stop hook: in the orchestrator's terminal, a reply that asks the decision-maker to decide, with no ask (GitHub) or
# needs-info note (board) recorded this turn, is sent back to record it first, so the inbox holds every decision asked.
# A block's own continuation (stop_hook_active) passes: no loop. Anywhere else, or on any error, it passes quietly.
[ -n "$HC_TERMINAL_ID" ] || exit 0
ROOT="$(cd "$(dirname "$0")/.." && pwd)" python3 -c '
import json, os, sys
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
if d.get("stop_hook_active") or cli._role(os.environ["HC_TERMINAL_ID"]) != "orchestrator":
    sys.exit()
why = cli.unrecorded_ask(d.get("last_assistant_message") or "", d.get("transcript_path"))
if why:
    print(json.dumps({"decision": "block", "reason": why}, ensure_ascii=False))
' 2>/dev/null
exit 0
