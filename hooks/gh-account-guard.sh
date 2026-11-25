#!/bin/sh
input=$(cat)
printf '%s' "$input" | grep -Eq '(^|[^[:alnum:]_.-])gh[[:space:]]' || exit 0
printf '%s' "$input" | node "$(dirname "$0")/../board/src/cli.ts" hook gh-account
