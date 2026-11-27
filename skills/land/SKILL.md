---
name: land
description: 编排者用。worker 报完成后收尾。收到回报，或票上出现 merge: 已合未收完、merge: 拒合时用。
---

worker 报完成，或票上出现 `merge:` 行时用。光凭回报不合并。

- **本机看板的票** → worker 自己跑 `nawaban merge <PR>`，它合并、跑 `--check`、更新插件、关票。你只看票上的 `merge:` 行：照它改，再让 worker 重跑同一条。它点名要拉 schema 的，直接做下一条，不用问。
- **合的是 nawaban 仓库** → 改 schema 或数据的先 `nawaban backup`，再 `git -C ~/.nawaban/plugin pull --ff-only && pnpm --dir ~/.nawaban/plugin/board install --frozen-lockfile && sh ~/.nawaban/plugin/herdr/install-mod.sh`。
- **别的仓库** → 照它 `docs/agents/review.md` 的合并节合，比如 `scripts/merge.sh <PR>`。合之前亲自看两样：head commit 上检查全过；有一条点名它的 `<reviewer> review：无挡…` 评论，只改 `.md` 的不要。没有合并节就跑 `GH_TOKEN=$(gh auth token --user <账号>) gh pr merge <PR> --squash --match-head-commit <sha>`。合后记 `pr:` 链接、`close --done`，再用 **dispatch-route** 给 worker 派下一张；没活了就 `hc kill <名字>`、`git worktree remove <worktree>`。
- **登记过 KR 的票关了** → 跑一次 `nawaban okr`，它打印的硬停走 **ask** 交给决策者。

检验：票已关，带一个已合并的 `pr:` 链接。
