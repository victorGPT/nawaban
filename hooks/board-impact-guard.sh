#!/bin/sh
hooks="$(dirname "$0")"
input=$(cat)

names_a_task_verb_or_merge() { printf '%s' "$input" | grep -Eq 'tasks|merge'; }

session_cwd() {
  cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  printf '%s' "${cwd:-.}"
}

board_tracks_this_repository() {
  route=$(node "$hooks/route.mjs" "$(session_cwd)" 2>/dev/null)
  [ "${route%% *}" = board ]
}

names_a_task_verb_or_merge || exit 0
board_tracks_this_repository || exit 0
printf '%s' "$input" | node "$hooks/../board/src/cli.ts" guard
