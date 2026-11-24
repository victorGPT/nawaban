#!/bin/sh
WRITE_EVERY_MINUTES=5
input=$(cat)
sid=$(printf '%s' "$input" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -n 1)
dir="${NAWABAN_BOARD_DIR:-$HOME/.nawaban/board}"
stamp="$dir/progress-stamps/$sid"

no_board_here_yet() { [ -z "$sid" ] || [ ! -f "$dir/token" ]; }
written_within_the_gap() { [ -n "$(find "$stamp" -mmin -"$WRITE_EVERY_MINUTES" 2>/dev/null)" ]; }

no_board_here_yet && exit 0
written_within_the_gap && exit 0
(printf '%s' "$input" | node "$(dirname "$0")/../board/src/cli.ts" hook progress) >/dev/null 2>&1 &
exit 0
