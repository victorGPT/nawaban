#!/bin/sh
# PreToolUse hook (Bash): in a repository with docs/agents/okr.toml, a merge (`gh pr merge`, `scripts/merge.sh <PR>`)
# waits until every ticket the PR is linked to has a KR 影响声明 (nawaban event <ID> --kind impact).
# GitHub closes an issue on merge (Closes #N) without nawaban close, so the close lock alone misses it.
root="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$root" python3 -c '
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
