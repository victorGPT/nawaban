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

is_the_orchestrator() {
  if [ -n "$HC_TERMINAL_ID" ]; then
    this_terminal_is_labelled_orchestrator
  else
    this_session_was_declared_orchestrator_of "$1" "$2"
  fi
}
