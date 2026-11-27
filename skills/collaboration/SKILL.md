---
name: collaboration
description: 人和 agent 在 nawaban 上的协作流程：需求怎么拆、任务怎么跑、角色怎么分工。Use when 同事问「我们怎么协作」；新人入职；要把一个需求拆成任务。
---

# 协作流程

人只管目标，agent 按任务干活，规矩写在仓库里。状态只存 tracker：新窗口、压缩后的窗口和同事读到的是同一份事实。

本文只讲跨仓库通用的流程。命令以 [nawaban skill](../nawaban/SKILL.md) 为准；仓库自己的 `AGENTS.md` 和 `docs/agents/` 和本文冲突时，以仓库为准。

## 五层各管一段

- **Markdown 定规矩：** 仓库的 `AGENTS.md`（`CLAUDE.md` 只写 `@AGENTS.md`）、`docs/agents/*.md`、`docs/adr/`、`GLOSSARY.md`。
- **Skill 教做法：** `grilling`、`to-spec`、`to-tickets` 把需求变成任务；`/pstack:poteto-mode` 做好一张任务；`nawaban` 记账。
- **CLI 是唯一写入口：** `nawaban` 写看板，`gh` 写 GitHub，`hc` 连终端。
- **Hook 在关键处强制：** 能机器查的规矩做成检查，做不成的才写进文档。
- **Tracker 是状态的唯一来源：** 有同事的仓库用 GitHub Issues，只有自己的仓库用本机看板，看仓库的 `docs/agents/issue-tracker.md`。

## 角色

- **决策者：** 定 Objective。KR 由编排者起草，决策者点头才算。决策者只答产品怎么表现、对外说什么、上不上生产。随时可以推翻任何决定。
- **编排者：** 决策者手敲 `/nawaban:orchestrator` 声明。拆任务、派活、核验收、合并、汇报，见 [orchestrator skill](../orchestrator/SKILL.md)。KR 以下的事自己定，记成决策记录。
- **worker：** 一任务一 PR，由 `nawaban dispatch` 在独立 worktree 里启动。同一泳道的任务按依赖顺序交给同一个 worker。
- **评审：** 换一个模型来审，只报挡合并的问题，每条附 `文件:行号`。谁审、审什么看仓库的 `docs/agents/review.md`。
- **同事：** 可以在自己机器上另声明编排者，管自己那条线。两个编排者互不派活，不替对方合并或拍板。
- **复盘：** 定时把返工、不该合的合并、只进了记忆的规矩，变成检查或写进仓库文档。

## 一个需求从进来到关掉

1. 决策者记进收件箱，或同事直接开 Issue。
2. 编排者用 `grilling` 盘问，只问决策者能定的事，问到都有答复为止。
3. 用 `to-spec` 发成一个 spec 任务：问题、方案、用户故事、实现决定、测试决定、不做什么。
4. 用 `to-tickets` 按下面的拆任务规则拆成子任务，拆法给决策者看过再派。
5. 编排者照 [dispatch-route skill](../dispatch-route/SKILL.md) 派活；可开工的任务可以并行派。
6. worker 认领、测试先行、实现，进展和决策记在任务上；碰到只有决策者能定的事，记成待决后停手。
7. 验收命令的输出和截图贴进 PR，不口头说「通过」。只做了任务一部分的 PR 写 `Refs #N`，整个做完才写 `Closes #N`。评审无挡且 CI 绿后，按仓库的合并方式合入；本机看板上 worker 跑 `nawaban merge <PR>`。
8. 编排者照任务的成功判据核目标，`nawaban merge` 关掉的任务也照样核；流程走齐只是必要条件。没达到就重派或上升。完成标准是任务上有已合并的 `pr:` 链接。
9. 编排者跑 `nawaban okr`。全绿就收工汇报，有红就再派、再测；`okr` 硬停时照它打印的做。

## 拆任务规则

- **垂直切片：** 每个任务打通一条窄而完整的路径（数据、接口、界面、测试），做完能单独验证。
- **一个上下文装得下：** 一个新会话能做完，一任务一 PR。
- **记泳道：** 开工前读的文档、改的目录、用的工具基本相同的任务，建票时带同一个 `--lane <名>`。
- **先预重构：** 需要的预重构单独成任务，放在最前。
- **被挡关系用原生依赖：** GitHub 用 `--blocked-by`，本机看板用 `nawaban block`。
- **宽重构走扩、迁、收：** 先让新形式与旧并存，按目录分批迁移（每批一个任务），最后删旧形式。

## 授权三档

判别只问一句：做错了能不能靠 revert 收回？收不回，或涉及别人的权限、数据、合规，归 C。

- **A 自决：** 标签、关任务、派活、合并、技术类 ADR、界面文案默认值。记一条决策记录。
- **B 先开工：** 可丢弃的建造（分支、draft PR、dry-run），停在合并和部署之前。
- **C 只决策者：** 合规、对外表态、权限与密钥、改产品行为、改指标口径、超出授权的花费。先记成待决，再问，见 [ask skill](../ask/SKILL.md)。

## 同事怎么加入

- **只在 Issue 上协作：** 什么都不用装，评论按前缀手写：`进展：` `决定：` `PR：`。
- **让自己的 agent 守同一套规矩：** 装 nawaban 插件，读仓库的 `AGENTS.md` 和 `docs/agents/`。装了之后前缀评论用 `nawaban event` 写。
- **自己当一条线的编排者：** 在自己机器上 `/nawaban:orchestrator`。改共享契约或发版的人在 PR 里写明，并知会对方。

## 各仓库自己的规矩

动一个仓库前，读它的这几份（有就读）。肉包（roubao）都有，是现成的范例。

- `docs/agents/orchestrator.md`：编排者规矩，声明时载入。
- `docs/agents/review.md`：谁审、审什么、怎么合并。
- `docs/agents/worker-commands.md`：worker 用的命令。
- `docs/agents/nightly-review.md`：定时复盘怎么跑。
- `docs/agents/okr.toml`：O 和 KR 的定义，`nawaban okr` 读它。
