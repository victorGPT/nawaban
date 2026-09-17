# Git 协作与冲突

一 pane 一 worktree,branch 与 index 各归各的;只剩两处要小心。

## 向已有 PR 追加 commit

先核对当前 worktree 分支与远程 PR head，保护未提交修改。PR head 已被其他执行者或项目 helper 更新时，按项目协作规则同步后再追加普通 commit；涉及历史重写先确认授权。push 前核对相对于 PR base 的完整 diff，确保只包含本任务交付。

以旧 worktree 的完整树配合 `commit-tree -p <PR head>` 会覆盖 PR head 新增的内容；同步时保留双方已提交的实际改动。

## 真撞了:意图还原

merge conflict 由第二个合的人解:先读两边 commit / PR / 卡还原双方意图 → 尽量双保留 → 不可兼得按本次 merge 目标取舍并在
PR body 记 trade-off → 解完跑 typecheck 与相关测试再提交。两边都没有的新行为不发明。
