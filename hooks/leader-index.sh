#!/bin/sh
# SessionStart hook: inject `nawaban index` and the repository's orchestrator rules (docs/agents/orchestrator.md)
# into a terminal the owner declared the orchestrator: `hc label $HC_TERMINAL_ID role=orchestrator`.
# Every other session, and sessions outside Herdr, get nothing.
[ -n "$HC_TERMINAL_ID" ] || exit 0
info=$(hc get "$HC_TERMINAL_ID" --json 2>/dev/null) || exit 0
printf '%s' "$info" | python3 -c '
import json, sys
sys.exit(0 if (json.load(sys.stdin).get("labels") or {}).get("role") == "orchestrator" else 1)' 2>/dev/null || exit 0
echo "nawaban index（现状索引，SessionStart 钩子注入；你是编排者，先读它再凭记忆补）："
python3 "$(dirname "$0")/../nawaban/cli.py" index
dir="${CLAUDE_PROJECT_DIR:-.}"
branch=$(git -C "$dir" branch --show-current 2>/dev/null)
[ -n "$branch" ] && [ "$branch" != main ] && echo "注意：${dir} 在分支 ${branch}，不在 main，下面读到的规矩可能是旧的；先查是谁切的，收拾后切回 main。"
rules="$dir/docs/agents/orchestrator.md"
# ponytail: leader.md is the name before orchestrator.md; drop this once no repository keeps it
[ -f "$rules" ] || rules="$dir/docs/agents/leader.md"
if [ -f "$rules" ]; then
  echo; echo "编排者规矩（${rules}，SessionStart 钩子注入）："; cat "$rules"
fi
exit 0
