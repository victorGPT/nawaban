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
# one orchestrator per repository: clear the label from any other live terminal in the same repository (worktrees included)
hc ls --json 2>/dev/null | python3 -c '
import json, subprocess, sys
def repo(d):
    if not d:
        return None
    r = subprocess.run(["git", "-C", d, "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None
me, mine = sys.argv[1], repo(sys.argv[2])
for t in json.load(sys.stdin).get("terminals", []):
    a = t.get("address")
    if not mine or a == me or repo(t.get("cwd", "")) != mine:
        continue
    r = subprocess.run(["hc", "get", a, "--json"], capture_output=True, text=True)
    try:
        role = (json.loads(r.stdout).get("labels") or {}).get("role")
    except ValueError:
        continue
    if role == "orchestrator" and subprocess.run(["hc", "label", a, "role="], capture_output=True).returncode == 0:
        print(f"已摘掉同仓库旧编排者 {a} 的标签。")
' "$HC_TERMINAL_ID" "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null
exec "$(dirname "$0")/leader-index.sh"
