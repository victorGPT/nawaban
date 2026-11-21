#!/bin/sh
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"

outside_herdr() { [ -z "$HC_TERMINAL_ID" ]; }

send_an_unrecorded_ask_back_to_the_tracker() {
  ROOT="$plugin_root" python3 -c '
import json, os, sys
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
continuing_its_own_block = d.get("stop_hook_active")
if continuing_its_own_block or cli._role(os.environ["HC_TERMINAL_ID"]) != "orchestrator":
    sys.exit()
why = cli.unrecorded_ask(d.get("last_assistant_message") or "", d.get("transcript_path"))
if why:
    print(json.dumps({"decision": "block", "reason": why}, ensure_ascii=False))
' 2>/dev/null
}

outside_herdr && exit 0
send_an_unrecorded_ask_back_to_the_tracker
exit 0
