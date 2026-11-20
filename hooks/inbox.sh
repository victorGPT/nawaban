#!/bin/sh
# Stop hook: in the orchestrator's terminal, show under every reply what waits on the decision-maker (收件箱):
# the repository's pending decisions (GitHub, from a cache file `nawaban index` refreshes) or 等你 tasks (board).
# Anywhere else, or on any error, it prints nothing and exits 0: it must never hold up a session.
[ -n "$HC_TERMINAL_ID" ] || exit 0
ROOT="$(cd "$(dirname "$0")/.." && pwd)" python3 -c '
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
