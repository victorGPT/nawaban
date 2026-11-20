#!/bin/sh
# Stop hook: in the orchestrator's terminal, show under every reply what waits on the decision-maker (收件箱):
# the repository's pending decisions (GitHub, from a cache file `nawaban index` refreshes) or 等你 tasks (board).
# A project moved to the board (hooks/route.mjs) reads them off it each time, with no cache.
# Anywhere else, or on any error, it prints nothing and exits 0: it must never hold up a session.
[ -n "$HC_TERMINAL_ID" ] || exit 0
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
set -- $(node "$hooks/route.mjs" "${cwd:-.}" 2>/dev/null)
if [ "$1" = board ]; then
  hc get "$HC_TERMINAL_ID" --json 2>/dev/null | python3 -c '
import json, sys
sys.exit(0 if (json.load(sys.stdin).get("labels") or {}).get("role") == "orchestrator" else 1)' 2>/dev/null || exit 0
  printf '%s' "$input" | node "$hooks/../board/src/cli.ts" inbox --project "$2" 2>/dev/null
  exit 0
fi
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
exit 0
