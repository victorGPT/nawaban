#!/bin/sh
# SessionStart hook: inject `nawaban index` and the repository's leader rules into a leader session
# (a Herdr terminal with no parent, or with children). Workers (a parent, no children) and sessions outside Herdr get nothing.
[ -n "$HC_TERMINAL_ID" ] || exit 0
hc ls --json | python3 -c '
import json, os, sys
me = os.environ["HC_TERMINAL_ID"]; ts = json.load(sys.stdin)["terminals"]
t = next((t for t in ts if t["address"] == me), {})
sys.exit(0 if not t.get("parent") or any(c.get("parent") == me for c in ts) else 1)' || exit 0
echo "nawaban index（现状索引，SessionStart 钩子注入；你是带队会话，先读它再凭记忆补）："
python3 "$(dirname "$0")/../nawaban/cli.py" index
rules="${CLAUDE_PROJECT_DIR:-.}/docs/agents/leader.md"
if [ -f "$rules" ]; then
  echo; echo "带队会话规矩（${rules}，SessionStart 钩子注入）："; cat "$rules"
fi
exit 0
