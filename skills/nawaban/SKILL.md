---
name: nawaban
description: "nawaban 看板就是 issue tracker。发 spec 和票、找可开工的票、做票之前、记进展决策链接、关票时用。"
---

# nawaban

做票之前、发 spec 或拆票、记进展决策和链接时用。票的状态只存在板上。名词以 `GLOSSARY.md` 为准，参数看 `nawaban <动词> --help`。

## 规矩

- 只拿三类问题问人：产品怎么表现、对外说什么、上不上生产。别的自己定。skill 明说交给人的步骤照旧交人。
- 每次在选项间做选择都记一条 `decision`，人答的也记。
- 先认领再干活，停手时关票或交还。

## 情况 → 做什么

- **不知道该干哪张** → `nawaban status` 看要管的，`nawaban list --frontier` 看可开工的。认领不查 frontier，你自己查。`nawaban show <票> --all` 看全部事件。
- **发 spec 或拆票** → `nawaban create <KEY> --priority P0|P1|P2 --body-file <文件>`，P1 带 `--kr`。spec 票的正文就是整份 spec，之后不改。子票带 `--parent`、`--blocked-by`、`--lane`，先建被依赖的票。正文怎么写见 [ticket](../ticket/SKILL.md)。
- **开工** → `nawaban claim <票>`。仓库有 `docs/agents/okr.toml` 时同时登记 `--o "<O>" --kr "<KR>=toward"`，纯文档和纯基础设施写 `--o 无`。第一个 PR 链接之后才登记算事后，不判也不计。
- **停手、做了选择、开了 PR** → 记 `note`、`decision`、`link` 事件，格式见 [events.md](events.md)。交还前先记 `note`。
- **要人答或要人动手** → 只有决策者能定的走 [ask](../ask/SKILL.md)。要事实或要人做事，先在对话里问，再 `nawaban event <票> wait "<一句>"`；答了用自己的话 `resolve "<结论>"`。
- **PR 开了** → 持票的 worker 在自己 worktree 跑 `nawaban merge <PR>`，Claude Code 里放后台。退出 3 是检查还在跑，过会儿重跑；拒合的理由记在票上，改完重跑。改了 `.md` 以外文件的 PR 要一条点名 head commit（≥7 位）的 `<reviewer> review：无挡…` 或 `<模型>（effort）评审结论：无挡…` 评论，之后再 push 要重审。
- **没走 merge 的合并** → 记 `pr:` 链接后 `nawaban close <票> --done`，登记过 KR 的带 `--kr "<KR>=<后值> 实测|预计"`。板上误关的票重开不了，新建一张，在旧票记 `note "重开为 <新票>"`；同步到 GitHub 的仓库（`github-sync.json`）里 issue #N 就是票 `<PROJECT>-<N>`，误关可以 `close --reopen`。
- **派活** → 编排者跑 `nawaban dispatch`，见 [dispatch-route](../dispatch-route/SKILL.md)。worker 用 `nawaban tell <票> "<一行>"` 回报，送不到就在票上记 `回报未送达：<那行>`。
- **看 KR** → `nawaban okr`，它不跑 eval。
- **GitHub 写操作** → `GH_TOKEN=$(gh auth token --user <账号>) gh …`，账号取 `docs/agents/issue-tracker.md` 的 `github-account:`，没有就取 `~/.nawaban/github-accounts.json` 里 origin 拥有者那条。
- **wayfinder 地图** → 见 [wayfinder.md](wayfinder.md)。

Codex、Antigravity、Claude Code 以外的会话，写之前把 `NAWABAN_OWNER` 设成固定的名字。

检验：你碰过的票，板上都看得到认领、进展、决策和已合并的 `pr:` 链接。
