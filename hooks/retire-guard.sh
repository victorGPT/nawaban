#!/bin/sh
input=$(cat)
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"

printf '%s' "$input" | grep -Eq 'hc[[:space:]]+(kill|rm)' || exit 0

printf '%s' "$input" | ROOT="$plugin_root" python3 -c '
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.environ["ROOT"])
from nawaban import cli
d = json.load(sys.stdin)
refusal, warning = cli.retire_refusal((d.get("tool_input") or {}).get("command", ""), Path(d.get("cwd") or os.getcwd()))
if refusal:
    print(refusal, file=sys.stderr)
    sys.exit(2)
if warning:
    print(json.dumps({"systemMessage": warning}, ensure_ascii=False))
'
