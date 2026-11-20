#!/bin/sh
# UserPromptSubmit and PostToolUse hook: renew the board claims this window holds (lease 1h), so a working window keeps
# its tasks and an idle one hands them back. ponytail: at most every 30 min (half the lease), so most calls cost a find.
# On any error, or with no board here yet, it prints nothing and exits 0: it must never hold up a session.
sid=$(sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -n 1)
dir="${NAWABAN_BOARD_DIR:-$HOME/.nawaban/board}"
[ -n "$sid" ] && [ -f "$dir/token" ] || exit 0
stamp="$dir/renewed/$sid"
[ -n "$(find "$stamp" -mmin -30 2>/dev/null)" ] && exit 0
mkdir -p "$dir/renewed" && touch "$stamp"
node "$(dirname "$0")/../board/src/cli.ts" renew --session "$sid" >/dev/null 2>&1
exit 0
