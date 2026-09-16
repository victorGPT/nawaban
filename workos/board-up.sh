#!/usr/bin/env bash
# board-up.sh — 收件箱/看板一键启动 · 幂等 (WORKOS-INBOX)
#   启动: board-up.sh          → http://127.0.0.1:8813/
#   停止: board-up.sh stop
#   状态: board-up.sh status
#
# 幂等是重点:已经在跑就直接告诉你地址,不会起第二个也不会打断正在用的那个。
# 进程用 nohup 脱离终端 —— 关掉起它的窗口不会带走板(否则「打开无效」就是这么来的)。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${WORKOS_BOARD_PORT:-8813}"
LOG="$DIR/board.log"

# 绑哪个地址:有 tailscale 就绑它的 100.x —— 本机和 tailnet 里的其他设备用同一个 URL。
# 绑死 127.0.0.1 的话,从别的设备(手机/另一台 Mac)打开 127.0.0.1:8813 指的是**那台设备自己**,
# 必然 connection refused。这正是 2026-08-14 那次「打开无效」的真因。
# 不绑 0.0.0.0:那会把板一并暴露给整个局域网;tailnet 只有你自己的设备。
# 本机那条永远绑上:tailnet 断线时(实测 macbook-air 掉线过)localhost 仍能开板。
HOST="${WORKOS_BOARD_HOST:-}"
if [ -z "$HOST" ]; then
  TS_IP="$(ifconfig 2>/dev/null | awk '/inet 100\./{print $2; exit}')"
  HOST="127.0.0.1"
  [ -n "$TS_IP" ] && HOST="127.0.0.1,$TS_IP"
fi
URL="http://${HOST%%,*}:$PORT/"          # 自检拉第一个(本机那条)
URL_TS="";  case "$HOST" in *,*) URL_TS="http://${HOST##*,}:$PORT/";; esac

# 库必须显式解析:board_view 默认从 **cwd** 向上找 .foreman/,
# 而这个脚本可能被从任何目录调用(从脚本自己的目录跑就必然找不到)。
# 顺序:WORKOS_DB → 从 cwd 向上找 → 已知的主仓库。
DB="${WORKOS_DB:-}"
if [ -z "$DB" ]; then
  d="$PWD"
  while [ "$d" != "/" ]; do
    [ -f "$d/.foreman/workos.db" ] && DB="$d/.foreman/workos.db" && break
    d="$(dirname "$d")"
  done
fi
[ -z "$DB" ] && [ -f "$HOME/projects/example/.foreman/workos.db" ] \
  && DB="$HOME/projects/example/.foreman/workos.db"
if [ -z "$DB" ]; then
  echo "找不到 workos.db —— 在仓库里跑,或设 WORKOS_DB=<路径>" >&2
  exit 1
fi

alive() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

case "${1:-start}" in
  stop)
    pkill -f "(board_view.py|workos-web).*--port $PORT" 2>/dev/null && echo "board stopped (:$PORT)" \
      || echo "board 本来就没在跑 (:$PORT)"
    exit 0 ;;
  status)
    if alive; then
      echo "✓ 在跑 → $URL  (库 $DB)"
      lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -n +2 | awk '{print "  pid",$2}'
      curl -s -m 3 -o /dev/null -w "  实拉 HTTP %{http_code}\n" "$URL" 2>/dev/null \
        || echo "  实拉失败 —— 端口占着但服务不响应,先 stop 再 start"
    else
      echo "✗ 没在跑 · 起它:$0"
    fi
    exit 0 ;;
esac

if alive; then
  echo "already running → $URL"
  exit 0
fi

# 看板由独立仓 WorkOS 提供(WORKOS-PROJECT-001 · 2026-09-16 切换);没装就回落本目录旧版
WEB="${WORKOS_HOME:-$HOME/Developer/workos}/.venv/bin/workos-web"
if [ -x "$WEB" ]; then
  nohup "$WEB" --db "$DB" --port "$PORT" --host "$HOST" >>"$LOG" 2>&1 &
else
  nohup python3 "$DIR/board_view.py" --db "$DB" --port "$PORT" --host "$HOST" >>"$LOG" 2>&1 &
fi
for _ in $(seq 1 20); do
  sleep 0.2
  alive && break
done

# 起完立刻从调用方位置实拉一次 —— 「进程在」不等于「打得开」
code=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "$URL" 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then
  echo "board up → $URL  (实拉 HTTP 200 · 日志 $LOG)"
  [ -n "$URL_TS" ] && echo "  手机/其他设备(需在 tailnet 上)→ $URL_TS"
  echo "  库 $DB"
  [ -n "$URL_TS" ] && echo "  (本机两个地址都能开;tailnet 那条在别的设备上才有意义)"
else
  echo "board 起了但实拉返回 $code —— 看日志:tail $LOG" >&2
  exit 1
fi
