#!/bin/sh
# PreToolUse hook (Bash): only the owner sets or clears the orchestrator label, by typing /nawaban:orchestrator
# or `! hc label <t> role=`. A model command that touches the role label is blocked.
# ponytail: matches the command text, so a label set through another program slips past; the hook is a guardrail, not a sandbox.
python3 -c '
import json, re, sys
cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
if re.search(r"\bhc\b[^\n;|&]*\blabel\b[^\n;|&]*\brole=", cmd):
    print("编排者标签只能由吴献忠手敲 /nawaban:orchestrator 设置，或用 ! hc label <窗口> role= 摘掉。", file=sys.stderr)
    sys.exit(2)
'
