# 交付与收尾

## 留下可接手的事实

`status`、`now`、refs 和最新 handoff 应反映已核实的交付版本与运行状态。记录实际 commit/PR/merge、验证命令与结果、未完成项及下一步；没有远程的项目用本地版本，不假定存在 origin/main。未查的 live 配置或真人验收明确标为未验证。

长证据保存在可访问的 artifact，卡上放指针。决策经 `decide` 追加，普通进展经 `event` 记录；字段与参数查 CLI 帮助。ADR、能力文档只在项目需要且本次行为变化涉及它们时更新。

## 状态与证据

按用户和项目的完成条件选择路径；状态闸接受一次写入不等于交付内容已验收。

| 情况 | 记录与动作 |
|---|---|
| 未合并或仅交付文件/commit | 保存 artifact/commit ref；用 handed_off 或 blocked 写真实进展。当前状态机没有“未合并内部任务直通 done”的路径。 |
| 内部任务已按授权实际合并且验证通过 | 登记实际 `merge_sha` ref，再从 in_progress advance 到 done。 |
| 项目要求目标运行环境验收 | 验证后登记 `acceptance_run`，再进入 staging-verified；`waiting_on` 按实际依赖选 decision/prod/observe/external。 |
| 需要真人验收或决定 | 按下节使用 ask；进入 decision 等待前必须已有未关闭的关联 ask。 |
| 还在等观察窗口、外部动作或部署 | 保留等待态与下一次核查条件；时间经过或取得授权不能代替动作与效果证据。 |

示例（先替换已核实的库、卡号与 SHA）：

```bash
workos --db <目标库> ref <ID> --kind merge_sha --value <实际合并SHA>
workos --db <目标库> advance <ID> --to done
```

状态的合法转换由 CLI/库校验。`waiting_on` 不是可任意编辑的字段；staging-verified 不能通过同态 advance 切换等待类型，按实际允许的返工/再验证路径处理，保留原证据。

## 需要用户动作时

已有授权覆盖的工作继续执行。仅当缺少必要决定、授权或项目要求真人验收时，使用 `workos ask --help` 构造一个具体问题，提供可审阅材料。

- `decide`：至少两个带后果的选项。
- `authorize`：说明将做的动作、影响范围与失败/回退方式。
- `accept`：给目标运行环境的读侧正向证据；PR 合并与 CI 通过不能代替它。

`answer` 代表用户回答，只能落实真实用户输入。accept 回答可能直接推进卡状态；authorize/decide 回答只记决策并关闭 ask，授权动作实际成功后才使用 `fanout --ok`。这些多卡操作逐卡提交；部分失败或结果未知时先核对已落决策和状态，再决定如何恢复，不能假定整批原子或安全重试。

`decide --by user` 受决策通道限制；设置通道不构成用户授权。decision 卡要求有效用户决定晚于最近验收时间；若同秒等条件导致拒绝，核对原始回答与时间再处理，不能虚构一次新回答以过闸。

## 记录本次尝试

```bash
workos --db <目标库> handoff <ID> --outcome handed_off \
  --summary "<完成内容、证据和剩余工作>" --now "<当前状态与下一步>"
```

- outcome 选真实结果。`completed` 仅用于 staging-verified/done，且不表示已经真人验收；仍待合并/执行时用 `handed_off`，有具体阻塞用 `blocked`。
- `--artifact` 指向已保存且实际存在的文件；`--now` 必填。
- handoff 结束本 session 的认领记录，不自动推进到 done。明确放弃 owner 时加 `--release`；它会让 claimed/in_progress 回到 open，其他状态保留而清 owner。
- 完成授权范围内的工作后，按 [workos-wrapup](../../workos-wrapup/SKILL.md) 查遗漏。恢复身份见 [运行入口](runtime.md)。
