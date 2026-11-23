#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
. "$hooks/orchestrator.sh"

session_cwd() {
  cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s' "${cwd:-${CLAUDE_PROJECT_DIR:-.}}"
}

route=$(node "$hooks/route.mjs" "$(session_cwd)" 2>/dev/null)
[ "${route%% *}" = board ] || exit 0
project=${route#* }
is_the_orchestrator "$input" "$project" || exit 0
node "$hooks/../board/src/cli.ts" page --project "$project" 2>/dev/null
exit 0
