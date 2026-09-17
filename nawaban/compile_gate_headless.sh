#!/bin/sh
# 编译闸的 headless 判别 wrapper(NAWABAN-CUTOVER 2026-08-13 用户拍板的激活形态)。
#
# 只咬 headless(`claude -p` · CLAUDE_CODE_ENTRYPOINT=sdk-cli)。理由(spike 实证):
# Stop hook **每轮**触发,不是 session 结束触发 —— 交互窗口每轮都以纯文本结束,
# Hermes「纯文本=终态」语义只在 headless 成立;交互窗口的收尾失守归巡检兜底。
#
# 非 headless 必须先把 stdin 读干净再退出:不读的话上游写 hook 输入时可能吃 SIGPIPE。
[ "${CLAUDE_CODE_ENTRYPOINT:-}" = "sdk-cli" ] || { cat > /dev/null; exit 0; }
exec python3 "$(dirname "$0")/compile_gate.py"
