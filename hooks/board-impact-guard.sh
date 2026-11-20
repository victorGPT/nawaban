#!/bin/sh
# PreToolUse hook (Bash), for repositories kept on the new board: refuses an agent closing a task with the board's
# CLI (vb|board|nawaban tasks complete|fail|cancel), which skips nawaban close and its KR 影响声明 check, and a merge
# (gh pr merge, scripts/merge.sh <PR>) whose tasks have none. ponytail: a grep first, so most calls never start node.
# Every other repository is impact-guard.sh's (hooks/route.mjs): one guard per repository.
input=$(cat)
printf '%s' "$input" | grep -Eq 'tasks|pr[[:space:]]+merge|merge\.sh' || exit 0
cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
set -- $(node "$(dirname "$0")/route.mjs" "${cwd:-.}" 2>/dev/null)
[ "$1" = board ] || exit 0
printf '%s' "$input" | node "$(dirname "$0")/../board/src/cli.ts" guard
