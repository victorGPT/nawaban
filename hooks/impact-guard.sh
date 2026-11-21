#!/bin/sh
input=$(cat)
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"

names_a_merge() { printf '%s' "$input" | grep -q merge; }

session_cwd() {
  cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s' "${cwd:-.}"
}

board_impact_guard_owns_this_repository() {
  route=$(node "$plugin_root/hooks/route.mjs" "$(session_cwd)" 2>/dev/null)
  [ "${route%% *}" = board ]
}

hold_the_merge_until_every_ticket_declares_its_impact() {
  printf '%s' "$input" | ROOT="$plugin_root" python3 -c '
import json, os, sys
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
os.chdir(d.get("cwd") or os.getcwd())
why = cli.merge_gate((d.get("tool_input") or {}).get("command", ""), cli.resolve_db(None))
if why:
    print(why, file=sys.stderr)
    sys.exit(2)
'
}

if names_a_merge && board_impact_guard_owns_this_repository; then
  exit 0
fi
hold_the_merge_until_every_ticket_declares_its_impact
