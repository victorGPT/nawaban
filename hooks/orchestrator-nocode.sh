#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"

what=$(printf '%s' "$input" | python3 "$hooks/repo_write.py" 2>/dev/null)
[ -n "$what" ] || exit 0

. "$hooks/orchestrator.sh"
route=$(node "$hooks/route.mjs" "$(repository_the_session_is_in "$input")" 2>/dev/null)
is_the_orchestrator "$input" "${route#* }" || exit 0

echo "编排者不写代码：这一步会改仓库文件（${what}）。交给 worker（nawaban dispatch）或 subagent。" >&2
exit 2
