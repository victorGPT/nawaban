#!/usr/bin/env bash
# PreToolUse(Bash) · foreman branch gate(2026-08-11 · BRANCH-GATE-001)。
#
# 把 agent-foreman 铁律「绝不 git checkout -b / 切分支」从 prose 自觉变成机制 —— 与 done_gate 同一哲学。
# 起因:2026-08-11 本人(agent)在共享主树连开两次分支,把别的窗口脚下的分支一起拽走了;
# 那条规矩当时就写在 skill 里,但会话没加载 skill = prose 拦不住。用户拍板:上硬闸。
#
# 危害模型:多窗口共享同一个 cwd(主工作区)。在它上面 checkout/switch,整个目录连带
# 其他窗口一起被拽到新分支 —— 别的窗口下一次 Edit 就写在了错的分支上,且它不会察觉。
#
# 拦什么(只拦"会动当前工作区 HEAD"的):
#   git checkout -b/-B <name> · git switch -c/-C <name>   建新分支并切
#   git checkout <已存在的本地分支> · git switch <branch>  切到已有分支
# 放行什么:
#   · **worktree 内一律放行** —— worktree 就是隔离手段,里面随便切(agent-foreman references/gates.md)
#   · git checkout -- <path> / git checkout <非分支参数>    恢复文件,不动 HEAD
#   · git worktree add [-b ...]                             正是本闸要引导的合规动作
#   · git branch <name>(只建不切)                          不动任何窗口的 HEAD,无害
#   · git switch --detach / checkout <sha>                  不是分支协调问题(且罕见)
#
# 逃生门:命令行前缀 FOREMAN_ALLOW_BRANCH_SWITCH=1。
#   与 done_gate 刻意不给 SKIP 的差别在**可读性**:done_gate 读的是自己进程的 env(读不到
#   inline 前缀,故给了等于没给);本闸读的是 stdin 里的命令**全文**,inline 前缀 grep 得到,
#   是真能用的逃生门。留它的理由是有一个合法场景:把被切歪的主树**还原**回原分支。
# 判定体在同目录 foreman_branch_gate.py —— 不内联成 heredoc:bash 5.x 的
# heredoc 走 pipe,macOS pipe 初始容量 512 字节,3.6KB 正文写一半就死锁
# (FOREMAN-BRANCHGATE-HANG-001 · 2026-08-28 · 栈 heredoc_write→write)。
set -u
input=$(cat 2>/dev/null || true)

exec python3 "$(dirname "${BASH_SOURCE[0]:-$0}")/foreman_branch_gate.py" "$input"
