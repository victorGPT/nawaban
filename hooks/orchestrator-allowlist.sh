#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"

what=$(printf '%s' "$input" | python3 "$hooks/orchestrator_allowed.py" 2>/dev/null)
[ -n "$what" ] || exit 0

. "$hooks/orchestrator.sh"
route=$(node "$hooks/route.mjs" "$(repository_the_session_is_in "$input")" 2>/dev/null)
is_the_orchestrator "$input" "${route#* }" || exit 0

echo "编排者只做编排：这一步查的是代码或数据（${what}），派 worker 查（nawaban dispatch）或派 subagent。编排者能用 nawaban、hc、gh issue/pr 的 view 和 list、git log/status，能读 docs/agents/、AGENTS.md、CLAUDE.md。" >&2
exit 2
