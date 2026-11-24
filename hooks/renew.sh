#!/bin/sh
LEASE_MINUTES=60
RENEW_EVERY_MINUTES=$((LEASE_MINUTES / 2))
sid=$(sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -n 1)
dir="${NAWABAN_BOARD_DIR:-$HOME/.nawaban/board}"
stamp="$dir/renewed/$sid"

no_board_here_yet() { [ -z "$sid" ] || [ ! -f "$dir/token" ]; }
renewed_within_half_the_lease() { [ -n "$(find "$stamp" -mmin -"$RENEW_EVERY_MINUTES" 2>/dev/null)" ]; }

renew_in_background_stamping_only_on_success() {
  (node "$(dirname "$0")/../board/src/cli.ts" hook renew --session "$sid" && touch "$stamp") </dev/null >/dev/null 2>&1 &
}

no_board_here_yet && exit 0
renewed_within_half_the_lease && exit 0
mkdir -p "$dir/renewed" || exit 0
renew_in_background_stamping_only_on_success
exit 0
