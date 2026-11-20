#!/bin/sh
# PreToolUse hook (Bash): in a repository with docs/agents/okr.toml, a merge (`gh pr merge`, `scripts/merge.sh <PR>`)
# waits until every ticket the PR is linked to has a KR 影响声明 (nawaban event <ID> --kind impact).
# GitHub closes an issue on merge (Closes #N) without nawaban close, so the close lock alone misses it.
# A project moved to the board is board-impact-guard.sh's instead (hooks/route.mjs): one guard per repository.
# ponytail: a grep first, so a command that names no merge never starts node.
input=$(cat)
root="$(cd "$(dirname "$0")/.." && pwd)"
if printf '%s' "$input" | grep -q merge; then
  cwd=$(printf '%s' "$input" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  set -- $(node "$root/hooks/route.mjs" "${cwd:-.}" 2>/dev/null)
  [ "$1" = board ] && exit 0
fi
printf '%s' "$input" | ROOT="$root" python3 -c '
import json, os, sys
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
os.chdir(d.get("cwd") or os.getcwd())
why = cli.merge_gate((d.get("tool_input") or {}).get("command", ""), cli.resolve_db(None))
if why:
    print(why, file=sys.stderr)
    sys.exit(2)
'
