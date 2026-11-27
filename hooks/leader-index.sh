#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
. "$hooks/orchestrator.sh"
dir=$(repository_the_session_is_in "$input")
rules="$dir/docs/agents/orchestrator.md"

route=$(node "$hooks/route.mjs" "$dir" 2>/dev/null)

warn_when_off_main() {
  branch=$(git -C "$dir" branch --show-current 2>/dev/null)
  if [ -n "$branch" ] && [ "$branch" != main ]; then
    echo "${dir} 不在 main（在 ${branch}），下面的规矩可能是旧的：查清谁切的，收拾后切回 main。"
  fi
}

print_orchestrator_rules() {
  [ -f "$rules" ] || return 0
  echo; echo "编排者规矩 ${rules}："; cat "$rules"
}

is_the_orchestrator "$input" "${route#* }" || exit 0
warn_unless_the_compact_window_is_the_orchestrators "$input"
[ -n "$route" ] && node "$hooks/../board/src/cli.ts" status --project "${route#* }"
warn_when_off_main
print_orchestrator_rules
exit 0
