#!/bin/sh
set -eu

plugin="$(cd "$(dirname "$0")" && pwd)"
board_dir="${NAWABAN_BOARD_DIR:-$HOME/.nawaban/board}"
port="${NAWABAN_BOARD_PORT:-4100}"
label="${NAWABAN_LAUNCHD_LABEL:-com.nawaban.board}"
bin_dir="${NAWABAN_BIN_DIR:-$HOME/.local/bin}"
agent="$HOME/Library/LaunchAgents/$label.plist"
SERVICE_START_SECONDS=20

fail() { echo "nawaban 安装停在这里：$*" >&2; exit 1; }
say() { echo "• $*"; }
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

require_prerequisites() {
  [ "$(uname)" = Darwin ] || fail "只支持 macOS（board 服务由 launchd 常驻）"
  command -v git >/dev/null || fail "没有 git"
  command -v node >/dev/null || fail "没有 node，要 22.18 或更新"
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' ||
    fail "node $(node -v) 太旧，要 22.18 或更新"
  command -v pnpm >/dev/null || fail "没有 pnpm（npm install -g pnpm）"
  command -v claude >/dev/null || fail "没有 Claude Code 的 claude 命令"
}

install_dependencies_and_build_the_page() {
  say "装 board 依赖、构建网页"
  pnpm --dir "$plugin/board" install --frozen-lockfile --silent
  pnpm --dir "$plugin/web" install --frozen-lockfile --silent
  pnpm --dir "$plugin/web" build >/dev/null
}

install_the_claude_code_plugin() {
  say "装 Claude Code 插件 nawaban@nawaban"
  claude plugin marketplace add "$plugin" >/dev/null
  claude plugin uninstall nawaban@nawaban >/dev/null 2>&1 || true
  claude plugin install nawaban@nawaban >/dev/null
}

write_the_nawaban_command() {
  say "写 $bin_dir/nawaban"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/nawaban" <<EOF
#!/bin/sh
export NAWABAN_BOARD_DIR="\${NAWABAN_BOARD_DIR:-$board_dir}" NAWABAN_BOARD_PORT="\${NAWABAN_BOARD_PORT:-$port}"
exec "$(command -v node)" "$plugin/board/src/cli.ts" "\$@"
EOF
  chmod 755 "$bin_dir/nawaban"
}

open_the_codex_sandbox_to_the_board() {
  command -v codex >/dev/null || return 0
  say "让 Codex 的 workspace-write 沙箱能连本机看板、写认领租约"
  node "$plugin/board/src/codex.ts"
}

write_the_launch_agent() {
  mkdir -p "$board_dir" "$(dirname "$agent")"
  chmod 700 "$board_dir"
  cat > "$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$(command -v node)")</string>
    <string>$(xml "$plugin/board/src/cli.ts")</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NAWABAN_BOARD_DIR</key>
    <string>$(xml "$board_dir")</string>
    <key>NAWABAN_BOARD_PORT</key>
    <string>$(xml "$port")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml "$board_dir/serve.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$board_dir/serve.log")</string>
</dict>
</plist>
EOF
}

start_the_board_service() {
  say "启动 board 服务 $label（launchd，127.0.0.1:$port）"
  write_the_launch_agent
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$agent"
  waited=0
  until [ -s "$board_dir/web-token" ] && curl -fsS -o /dev/null "http://127.0.0.1:$port/"; do
    waited=$((waited + 1))
    [ "$waited" -le "$SERVICE_START_SECONDS" ] || fail "board 服务 $SERVICE_START_SECONDS 秒内没起来，看 $board_dir/serve.log"
    sleep 1
  done
}

require_prerequisites
install_dependencies_and_build_the_page
install_the_claude_code_plugin
write_the_nawaban_command
open_the_codex_sandbox_to_the_board
start_the_board_service

echo
echo "装好了。board 在 $board_dir，网页在 http://127.0.0.1:$port/。"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "把 $bin_dir 加进 PATH（如 echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.zshrc），nawaban 命令才找得到。" ;;
esac
echo "下一步：nawaban web 打开网页；在你的项目里开一个新的 Claude Code 会话，输入 /nawaban:orchestrator 声明编排者。"
