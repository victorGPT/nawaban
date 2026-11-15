#!/bin/sh
# PreToolUse hook (Bash): only the owner sets or clears the orchestrator label, by typing /nawaban:orchestrator
# or `! hc label <t> role=`. A model command that touches the role label is blocked.
# ponytail: matches the command text, erring toward blocking; a label set through another program slips past, so this is a guardrail, not a sandbox.
python3 -c '
import json, re, sys
cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
flat = re.sub(r"\\\n|[\x27\"\\]", "", cmd)  # drop quotes, backslashes and line continuations the shell would remove
if re.search(r"\bhc\b.*\blabel\b.*\brole\b", flat, re.S):
    print("编排者标签只能由吴献忠手敲 /nawaban:orchestrator 设置，或用 ! hc label <窗口> role= 摘掉。", file=sys.stderr)
    sys.exit(2)
'
