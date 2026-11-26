#!/bin/sh
input=$(cat)
hooks="$(cd "$(dirname "$0")" && pwd)"
. "$hooks/orchestrator.sh"
[ -n "$HC_TERMINAL_ID" ] || exit 0

printf '%s' "$input" | ROOT="$(cd "$hooks/.." && pwd)" python3 -c '
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
root = cli.github_root(Path(d.get("cwd") or os.getcwd()))
if not root or cli._role(os.environ["HC_TERMINAL_ID"]) != "orchestrator":
    sys.exit()
said = cli.retire_sweep_message(root)
if said:
    print(json.dumps({"systemMessage": said}, ensure_ascii=False))
' 2>/dev/null
exit 0
