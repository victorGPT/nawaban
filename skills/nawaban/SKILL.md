---
name: nawaban
description: 认领、推进或恢复 nawaban 任务，处理工位与状态闸；只查进度时保持只读。
metadata:
  version: "6.0.0"
---

# nawaban 任务协作

让任务卡、工作区和交付证据保持一致，完成用户授权的目标。nawaban 管卡、工位与状态；实现方法和交付范围遵循目标项目。

## 开始或续做

读取目标卡的 `success`、`constraints`、`touches`、owner、status、now 和相关 refs；按需读关联 ADR。以当前用户要求和项目 tracker 为准，已有决策与同一范围的授权继续有效。

- **查询或评审**：读取所需状态与证据即可。请求“看看谁在做”不触发认领、建卡或编辑。
- **实施**：确认可验证的完成条件，再认领并进入本卡工位。仅对会改变范围、行为或风险的缺失决定提问；其余选择自行处理。
- **续做**：先核对 owner、最新 handoff 与现有 worktree，复用本卡工位；已完成的步骤无需重跑。卡已回收为 open 时重新 claim → start，别人的 owner 需要先协调。

首次使用或跨项目时读 [运行入口与身份](references/runtime.md)，确认 CLI、目标数据库和会话身份。相对链接按本 Skill 的真实路径解析（安装入口可能是符号链接）。

## 认领与工位

写操作携带会话提供的 `NAWABAN_OWNER` 和 `CLAUDE_CODE_SESSION_ID`。所有操作保持同一目标库；以下命令中的占位符先替换为已核实的值。

```bash
nawaban --db <目标库绝对路径> claim <ID>
nawaban --db <目标库绝对路径> start <ID> --now "<当前要完成的工作>"
git worktree add <独立工位路径> -b task/<ID>
```

仅在本卡还没有工位时创建 worktree。共享主树保持 `main`，项目文件在本卡 worktree 修改；已授权的仓外文件按 touches 实址处理。范围扩大先确认授权并通过 `scope` 落板，再编辑。claim 的占用 WARN 是协调提示，不能代替范围合同。

## 推进与完成

持续完成已授权的实现、相关检查及其修复，直到 success 满足或出现需要外部输入的具体阻塞。依据受影响行为选择验证；检查通过后，仅因新变更、失败或未解风险补验。涉及运行效果时检查目标运行环境；本地测试、部署结果与真人验收分别记录。

交付边界由用户和项目决定：本地文件、commit、PR、合并、部署各自需要对应范围的授权。本 Skill 不自动要求开 PR、部署或另接一张卡。未合并工作记录 commit/artifact 和真实交接态，不能为了 done 填造 merge_sha。

结束前按 [交付与收尾](references/cards.md) 同步 status、now、refs 和 handoff；如有待办，留下证据、剩余工作与一个明确下一步。仅需清点本 session 时使用 [nawaban-wrapup](../nawaban-wrapup/SKILL.md)。

## 按情况读取

| 当前情况 | 参考 |
|---|---|
| 无卡、需要拆分目标或记录决策 | [建卡与需求边界](references/grill-protocol.md) |
| claim 占用提示或依赖/编辑/归档被拒 | [占用协调](references/locks.md)、[状态与 hook 闸](references/gates.md)，只读相关项 |
| 总监派单或明确采用 worker 协议 | [Worker 协议](references/director-worker.md) |
| PR 在范围内或项目要求独立评审 | [PR 与评审](references/review-pr.md)；追加 PR 提交或冲突时再读 [Git 协作](references/git-shared-tree.md) |
| 需要额外能力或读取旧 Markdown 卡 | [能力目录](references/skill-shelf.md)、[历史卡](references/md-cards.md)，按需二选一 |

## 外部能力解析

只在下列条件成立且能力已启用时加载；可选能力缺失不阻塞普通任务。此表也供可选 skill_shelf 盘点工具读取。

| 条件 | 可选能力 |
|---|---|
| 重要需求分叉尚未解决 | `grilling` 或当前需求澄清能力 |
| 项目要求特定实现或评审方法 | 按项目选择 `tdd`、`code-review` 或已启用的等价能力 |
