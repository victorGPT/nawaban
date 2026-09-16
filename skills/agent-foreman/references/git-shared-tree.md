# git:foreman_pr 之后与撞车之后

一 pane 一 worktree,branch 与 index 各归各的;只剩两处要小心。

## foreman_pr.sh 之后追加 commit

PR head 是脚本在当时最新 origin/main 上 squash 出来的,worktree 分支基线更旧。追加前先
先保护未提交修改并 rebase 到已核实的 PR head，再追加普通 commit;push 前 `git diff --stat origin/main HEAD` 消除非本卡文件。
拿旧 worktree 树 `commit-tree -p <PR head>` 会把别人刚合进 main 的改动静默回退进 PR（历史问题）。

## 真撞了:意图还原

merge conflict 由第二个合的人解:先读两边 commit / PR / 卡还原双方意图 → 尽量双保留 → 不可兼得按本次 merge 目标取舍并在
PR body 记 trade-off → 解完跑 typecheck 与相关测试再提交。两边都没有的新行为不发明。
