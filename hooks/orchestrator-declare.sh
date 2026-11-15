#!/bin/sh
# UserPromptSubmit hook: the owner typing /nawaban:orchestrator declares this terminal the orchestrator.
# The label is set here, from the owner's keystroke, never by the model (orchestrator-guard.sh blocks that).
prompt=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("prompt","").strip())' 2>/dev/null)
case "$prompt" in
  /nawaban:orchestrator*) ;;
  *) exit 0 ;;
esac
if [ -z "$HC_TERMINAL_ID" ] || ! hc label "$HC_TERMINAL_ID" role=orchestrator >/dev/null 2>&1; then
  echo "声明失败：这个会话不在 Herdr 里，或 hc label 出错；没有打上编排者标签。"
  exit 0
fi
echo "已给终端 ${HC_TERMINAL_ID} 打上编排者标签。"
exec "$(dirname "$0")/leader-index.sh"
