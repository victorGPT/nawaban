board_dir="${NAWABAN_BOARD_DIR:-$HOME/.nawaban/board}"

the_terminal_runs_this_hook() {
  root=$(hc get "$HC_TERMINAL_ID" --json 2>/dev/null | python3 -c 'import json, sys; print(json.load(sys.stdin).get("pid") or "")' 2>/dev/null)
  [ -n "$root" ] || return 1
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$p" = "$root" ] && return 0
    set -- $(ps -o ppid=,command= -p "$p" 2>/dev/null)
    case " $* " in *" app-server "*) return 1 ;; esac
    p=$1
  done
  return 1
}

if [ -n "$HC_TERMINAL_ID" ] && ! the_terminal_runs_this_hook; then
  unset HC_TERMINAL_ID
fi

session_of() {
  printf '%s' "$1" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -n 1
}

repository_the_session_is_in() {
  session_dir=$(printf '%s' "$1" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  session_dir=${session_dir:-${CLAUDE_PROJECT_DIR:-.}}
  git -C "$session_dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$session_dir"
}

declared_session_file() {
  printf '%s/orchestrator/%s' "$board_dir" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
}

this_terminal_is_labelled_orchestrator() {
  info=$(hc get "$HC_TERMINAL_ID" --json 2>/dev/null) || return 1
  printf '%s' "$info" | python3 -c '
import json, sys
sys.exit(0 if (json.load(sys.stdin).get("labels") or {}).get("role") == "orchestrator" else 1)' 2>/dev/null
}

this_session_was_declared_orchestrator_of() {
  sid=$(session_of "$1")
  [ -n "$sid" ] && [ -n "$2" ] && [ "$(cat "$(declared_session_file "$2")" 2>/dev/null)" = "$sid" ]
}

orchestrator_compact_window=250000

quoted() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

the_terminal_root_is_its_own_shell() {
  hc get "$HC_TERMINAL_ID" --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
sys.exit(0 if d.get("pid") and d.get("pid") != (d.get("foreground") or {}).get("pid") else 1)' 2>/dev/null
}

restart_line_with_the_orchestrator_window() {
  sid=$(session_of "$1")
  launch_dir=$(printf '%s' "$1" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  launch_dir=$(quoted "${launch_dir:-${CLAUDE_PROJECT_DIR:-$PWD}}")
  if [ -n "$HC_TERMINAL_ID" ] && ! the_terminal_root_is_its_own_shell; then
    printf '在本窗口输入框粘贴这一行回车（新终端带 role=orchestrator 标签接着这个会话，旧终端摘标签后关掉）：! hc run --bg --no-parent --label role=orchestrator --cwd %s env CLAUDE_CODE_AUTO_COMPACT_WINDOW=%s claude --resume %s && hc label %s role= && hc kill %s' \
      "$launch_dir" "$orchestrator_compact_window" "$sid" "$HC_TERMINAL_ID" "$HC_TERMINAL_ID"
  else
    printf '先 /exit 回到这个终端的 shell，再粘贴这一行回车（同一终端、同一会话，标签不动）：cd %s && CLAUDE_CODE_AUTO_COMPACT_WINDOW=%s claude --resume %s' \
      "$launch_dir" "$orchestrator_compact_window" "$sid"
  fi
}

warn_unless_the_compact_window_is_the_orchestrators() {
  [ -n "$CLAUDECODE" ] || return 0
  [ "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" = "$orchestrator_compact_window" ] && return 0
  echo "编排者的自动压缩窗口要 ${orchestrator_compact_window}，这个会话的 CLAUDE_CODE_AUTO_COMPACT_WINDOW 是 ${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-未设}（只在启动时读），要重启一次。把下面这句原样转给决策者：$(restart_line_with_the_orchestrator_window "$1")"
}

is_the_orchestrator() {
  if [ -n "$HC_TERMINAL_ID" ]; then
    this_terminal_is_labelled_orchestrator
  else
    this_session_was_declared_orchestrator_of "$1" "$2"
  fi
}
