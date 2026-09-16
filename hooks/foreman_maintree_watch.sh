#!/usr/bin/env bash
# Stop hook · 共享主树脏度看门(WORKTREE-GATE-001 · 2026-08-20)。
#
# guard.py 的 worktree 闸挡住了 Edit/Write/MultiEdit,但挡不住 Bash 里的
# `sed -i` / `> 文件` / heredoc / `make gen-*` —— 开放式 shell 要靠正则判「这条命令
# 会不会写主树」,误伤率高到不值当(而 python heredoc 里用 pathlib 写文件更是拦不到)。
#
# 所以这一层不拦,只**当轮报**:会话开始时记一个基线,每轮结束比一次。
# 只在「本会话把主树弄得更脏了」时出声 —— 别人留下的脏不归你,不唠叨。
# 判例 2026-08-20:主树积了 220 个未提交文件 + 36 个 stash,别的窗口
# `git pull --ff-only` 被堵了两天,没有任何一处会说出来。
#
# 永不阻塞:一律 exit 0。Stop 上返 2 会把会话钉在原地,而这里的脏很可能不是
# 当前 agent 能收拾的(别人的 WIP)—— 那就成了死循环。
set -u
exec 2>/dev/null

payload=$(cat 2>/dev/null || true)
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
sid=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
[ -n "$cwd" ] || exit 0
[ -d "$cwd/.git" ] || exit 0                      # 只看主 worktree(linked 的 .git 是文件)
[ -f "$cwd/.foreman/workos.db" ] || exit 0        # 只在上了 foreman 板的仓生效

# 计数用 wc 不用 `grep -c . || echo 0` —— grep 零匹配退出码 1,`||` 会再吐一个 0,
# 变量成了两行 "0\n0",后面整数比较当场报错,而 stderr 被吞 = 看门狗静默失效。
now=$(git -C "$cwd" status --porcelain 2>/dev/null | wc -l | tr -d " ")
case "$now" in ''|*[!0-9]*) exit 0 ;; esac

state_dir="$HOME/.claude/state"
mkdir -p "$state_dir" || exit 0
key=$(printf '%s' "$cwd$sid" | shasum | cut -c1-16)
base_file="$state_dir/maintree-base-$key"

if [ ! -f "$base_file" ]; then
  printf '%s' "$now" > "$base_file"               # 本会话第一轮 = 基线,不出声
  exit 0
fi

base=$(cat "$base_file" 2>/dev/null || echo "$now")
case "$base" in ''|*[!0-9]*) base=$now ;; esac

if [ "$now" -gt "$base" ]; then
  printf '⚠️  这个会话把共享主树弄脏了 %s 个文件(开工时 %s · 现在 %s)\n' \
    "$((now - base))" "$base" "$now" >&1
  printf '   主树是所有窗口共用的,未提交改动会堵住别人的 git pull。\n' >&1
  printf '   查:git -C %s status --short\n' "$cwd" >&1
  printf '   收:开个 worktree 把活挪进去,或提交到一个分支;别留在主树上。\n' >&1
  printf '%s' "$now" > "$base_file"               # 报过一次就抬基线,同一笔脏不重复唠叨
fi
exit 0
