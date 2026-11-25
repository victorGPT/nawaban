#!/bin/sh
input=$(cat)
printf '%s' "$input" | grep -Eq '(^|[^[:alnum:]_.-]|\\[nt])gh([[:space:]]|\\[nt])' || exit 0
printf '%s' "$input" | node "$(dirname "$0")/../board/src/cli.ts" hook gh-account
