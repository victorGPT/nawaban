#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
. "$hooks/orchestrator.sh"
dir=$(repository_the_session_is_in "$input")
rules_dir="$dir/docs/agents"
current_rules="$rules_dir/orchestrator.md"
legacy_rules="$rules_dir/leader.md"

route=$(node "$hooks/route.mjs" "$dir" --reads 2>/dev/null)

print_index_from_the_tracker_this_repository_uses() {
  if [ "${route%% *}" = board ]; then
    node "$hooks/../board/src/cli.ts" status --project "${route#* }"
  else
    (cd "$dir" && python3 "$hooks/../nawaban/cli.py" index)
  fi
}

warn_when_off_main() {
  branch=$(git -C "$dir" branch --show-current 2>/dev/null)
  if [ -n "$branch" ] && [ "$branch" != main ]; then
    echo "注意：${dir} 在分支 ${branch}，不在 main，下面读到的规矩可能是旧的；先查是谁切的，收拾后切回 main。"
  fi
}

print_orchestrator_rules() {
  rules="$current_rules"
  [ -f "$rules" ] || rules="$legacy_rules"
  [ -f "$rules" ] || return 0
  echo; echo "编排者规矩（${rules}，SessionStart 钩子注入）："; cat "$rules"
}

is_the_orchestrator "$input" "${route#* }" || exit 0
warn_unless_the_compact_window_is_the_orchestrators "$input"
echo "nawaban status（现状索引，SessionStart 钩子注入；你是编排者，先读它再凭记忆补）："
print_index_from_the_tracker_this_repository_uses
warn_when_off_main
print_orchestrator_rules
exit 0
