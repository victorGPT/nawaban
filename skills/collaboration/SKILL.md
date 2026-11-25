---
name: collaboration
description: 人和 agent 在 nawaban 上的协作流程：需求怎么拆、任务怎么跑、角色怎么分工。Use when 同事问「我们怎么协作」；新人入职；要把一个需求拆成任务。
---

# 协作流程

人只管目标，agent 按任务干活，规矩写在仓库里。状态只存 tracker，不存哪个窗口的记忆：新窗口、压缩后的窗口、同事，读到的是同一份事实。

本 skill 只讲跨仓库通用的流程。命令和格式以 [`nawaban` skill](../nawaban/SKILL.md) 为准，编排者怎么声明以 [`orchestrator` skill](../orchestrator/SKILL.md) 为准，每个仓库自己的规矩以它的 `AGENTS.md` 和 `docs/agents/` 为准；它们和本文冲突时，以它们为准。

## 五层各管一段

- **Markdown** 定规矩：仓库的 `AGENTS.md`（`CLAUDE.md` 只写 `@AGENTS.md`）、`docs/agents/*.md`、`docs/adr/`、`GLOSSARY.md`。改约定就改这里。
- **Skill** 教做法：Matt Pocock 的工程 skill（`grilling` → `to-spec` → `to-tickets`）管需求怎么变成任务；`/pstack:poteto-mode` 管一张任务怎么做好；`nawaban` 管记账。
- **CLI** 是唯一写入口：`nawaban`（claim、event、close、dispatch、status、okr…），GitHub 用 `gh`，终端之间用 `hc`。
- **Hook** 在关键处强制：能机器查的规矩做成检查，做不成的才写进文档。
- **Tracker** 是状态的唯一来源：有同事的仓库用 GitHub Issues，只有自己的仓库用本机看板。仓库用哪个，看它的 `docs/agents/issue-tracker.md`。

## 角色

- **决策者**：只管 O。定 Objective，KR 由编排者起草、决策者点头才算。只回答三类问题：产品该怎么表现、对外说什么、上不上生产。随时可以推翻任何决定，推翻后以决策者为准。
- **编排者**：替决策者管一个项目的会话，由决策者手敲 `/nawaban:orchestrator` 声明（agent 自己声明不了）。拆任务、派活、核验收、合并、汇报；KR 以下的事自己定，记成决策记录。
- **worker**：一任务一 PR。同一泳道的任务按依赖顺序交给同一个 worker 接着做，它的上下文用过一半才换新的。由 `nawaban dispatch` 在独立 worktree 里启动，以 `/pstack:poteto-mode` 开场。只在完成或受阻时给编排者发一行（结果和 PR 号）；结论、实测输出、中途进展只记在任务上，因为每条消息都会叫醒编排者。
- **评审**：换一个模型来审，写代码的模型自审不算。只报挡合并的问题，每条附 `文件:行号`。谁来审、审什么，看仓库的评审规矩。
- **同事**：可以在自己机器上另声明编排者，管自己那条线。两个编排者互不派活，不替对方合并或拍板。
- **复盘**：定时把返工、不该合的合并、只进了记忆没进仓库的规矩，变成检查或写进仓库文档。

## 一个需求从进来到关掉

1. **需求进来**：决策者记进收件箱交给编排者，或同事直接开 Issue。
2. **盘问**（`grilling`）：编排者只问只有决策者能定的事，其余自己定并记成决策记录。盘问到只有决策者能定的事都有了答复为止。
3. **写 spec**（`to-spec`）：发成一个 spec 任务，写明问题、方案、用户故事、实现决定、测试决定、不做什么。
4. **拆任务**（`to-tickets`）：按下面的拆任务规则拆成子任务，挂上被挡关系。拆法给决策者看过再派。
5. **派活**：`nawaban dispatch` 拉 worktree、启动 worker、把目标、范围、验收写进任务。可开工的任务（前置都已完成、没人认领）可以并行派。
6. **做**：worker 认领、复述目标、测试先行、实现。每个停顿点记进展同步，每次取舍记决策记录；遇到只有决策者能定的事，记成待决后停手。命令见 nawaban skill 的「Claim, release, close」和「Record events」，GitHub 上用同样的命令操作 `'#N'`。
7. **PR、评审、CI**：验收命令的输出和截图贴进 PR，不口头说「通过」。只做了任务一部分的 PR 写 `Refs #N`，整个做完才写 `Closes #N`，免得合并时误关。评审无挡合并的问题且 CI 绿，按仓库的合并方式合入；本机看板上由 worker 跑 `nawaban merge <PR>` 合入并关任务，编排者只在失败时收到一行。
8. **核验收，关任务**：编排者对照任务的成功判据核目标（`nawaban merge` 关掉的任务也照样核）；流程走齐只是必要条件。没达到就重派或上升。完成标准是任务上有已合并的 `pr:` 链接。
9. **OKR 自查，汇报**：跑 `nawaban okr`。全绿收工汇报；有红就判断差在哪、再派、再测。连续两轮没有 KR 往目标动、或冲刺跑满 5 轮，`okr` 会硬停（退出 3，打印「硬停：<O>」，草稿写到 `~/.nawaban/board/okr-stop/`）：补上「建议」用 `event --kind ask` 发给决策者，等 resolve 之后跑 `okr --resume <O>`。

## 拆任务规则

- **垂直切片**：每个任务打通一条窄而完整的路径（数据、接口、界面、测试），做完能单独演示或验证。
- **一个上下文装得下**：一个新会话能做完，一任务一 PR。
- **记泳道**：建票时带 `--lane <名>`（`nawaban create <ID> --title … --lane <名>`；旧的 note「lane: <名>」照样读，不再写）。开工前要读的文档、要改的目录、要用的工具基本相同，就是同一泳道；同泳道的任务派给同一个 worker，见 nawaban skill 的 Dispatch 一节。
- **先预重构**：先让改动变容易，再做容易的改动。需要的预重构单独成任务，放在最前。
- **被挡关系用原生依赖**：GitHub 用 `--blocked-by`，本机看板用 `nawaban block`。
- **宽重构走扩、迁、收**：一次改名会炸遍全库时，先让新形式与旧并存，按目录分批迁移（每批一个任务），最后删旧形式。
- **正文两段**：要做出什么（从用户视角）和成功判据（可检查，写明要贴的命令输出）。挂在 KR 上的任务带 KR 影响声明。

## 什么事归谁定：授权三档

判别只问一句：做错了能不能靠 revert 收回？收不回，或涉及别人的权限、数据、合规，归 C。

- **A 自决**：标签、关任务、派活、合并、技术类 ADR、界面文案默认值。记一条决策记录即可。
- **B 先开工**：可丢弃的建造（分支、draft PR、dry-run），停在合并和部署之前。
- **C 只决策者**：合规、对外表态、权限与密钥、改产品行为、改指标口径、超出授权的花费。

C 档的事写成待决交给决策者：先记在 tracker 上，再问；只在聊天里问的，决策者的待决提示行里看不到。待决的格式和就绪标准见 nawaban skill 里 `ask` 那一段。

## 决策者看到什么

待决提示行、面板见 nawaban skill，要决策者拍板见 ask skill，网页答复见 intake skill。编排者汇报分四栏：进展（各 KR 现值对目标）、受阻、代为决定（只列挂 KR 的）、硬闸（待批的部署、合规、密钥）。决策者说「同步」时改为逐件给待决。

## 同事怎么加入

- **只在 Issue 上协作**：什么都不用装。评论按前缀手写，看板照样读得到：`进展：` `决定：` `PR：`。
- **让自己的 agent 守同一套规矩**：装 nawaban 插件（CLI、skill、hook），读仓库的 `AGENTS.md` 和 `docs/agents/`。装了插件之后，前缀评论一律用 `nawaban` 命令写，手写会被 hook 拦。
- **自己当一条线的编排者**：在自己机器上 `/nawaban:orchestrator`，管自己开或认领的任务。共享契约和发版两条线，谁改谁在 PR 里写明并知会对方。

## 各仓库自己的规矩

仓库专有的做法只在仓库里写，本文不抄。动一个仓库前，读它的这几份（有就读）：

- `docs/agents/orchestrator.md`：编排者规矩，`/nawaban:orchestrator` 声明时载入。
- `docs/agents/review.md`：谁来审、审什么、怎么合并。
- `docs/agents/worker-commands.md`：worker 用的命令。
- `docs/agents/nightly-review.md`：定时复盘怎么跑。
- `docs/agents/okr.toml`：O 和 KR 的定义，`nawaban okr` 读它。

肉包（roubao）这几份都有，是现成的范例。
