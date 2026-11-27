#!/bin/sh
python3 -c '
import json, re, sys
SHELL_REMOVED_QUOTING = r"\\\n|[\x27\"\\]"
ROLE_LABEL_COMMAND_TEXT = r"\bhc\b.*\blabel\b.*\brole\b"
cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
as_the_shell_reads_it = re.sub(SHELL_REMOVED_QUOTING, "", cmd)
if re.search(ROLE_LABEL_COMMAND_TEXT, as_the_shell_reads_it, re.S):
    print("编排者标签只能由决策者手敲 /nawaban:orchestrator 设置，或用 ! hc label <窗口> role= 摘掉。", file=sys.stderr)
    sys.exit(2)
'
