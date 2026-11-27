#!/bin/sh
input=$(cat)
printf '%s' "$input" | grep -Eq 'hc[[:space:]]+(kill|rm)' || exit 0
printf '%s' "$input" | python3 "$(dirname "$0")/retire_guard.py"
