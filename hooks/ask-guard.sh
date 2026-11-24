#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
. "$hooks/orchestrator.sh"

route=$(node "$hooks/route.mjs" "$(repository_the_session_is_in "$input")" 2>/dev/null)
project=${route#* }

is_the_orchestrator "$input" "$project" || exit 0
printf '%s' "$input" | node "$hooks/../board/src/cli.ts" hook ask-guard --tracker "${route%% *}" 2>/dev/null
exit 0
