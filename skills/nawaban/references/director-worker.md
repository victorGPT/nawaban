# Worker 协议

仅在本会话是被主控派出的 worker，或项目明确采用本协议时加载；普通用户任务按 [主流程](../SKILL.md) 执行。

## 进场

先读卡；`constraints` 中的 `skills:` 是本卡已选定能力，按当前启用名称解析。方法取决于本次目标：Skill 文案用 writing-for-agents，领域/ADR、原型、TDD 或部署说明仅在对应工作确实需要时加载。

本会话由 `nawaban dispatch` 起，所在目录已是本卡的独立工位，不再另建。卡完成或交接后主控用 `nawaban dismiss` 停掉会话并清理工位，所以停下前把改动提交并推送，没推送的工位不会被清理。不在 worker 里再起具名子 agent 当 worker；子 agent 只用于查代码和评审。

## 汇报

使用同一目标数据库和真实会话身份：

- 阶段进展：`nawaban --db <目标库> notify <ID> --kind stage --msg "<结果、证据与下一步>"`。
- 具体阻塞：写 blocked 信，说明事实和需要的动作；有可独立推进的工作继续处理。
- 验收责任：按卡的 success 逐条验证，登记实际 acceptance_run 和被审版本；未满足时不报 done。
- 需要用户动作：经 ask 提交材料；notify 汇报状态，两者不互相替代。
- 扩界：在 blocked 信里写明所需路径与理由；得到覆盖该动作的授权并确认 scope 已落板后再编辑。沿用已有授权，避免重复申请。

本地 nawaban notify 是板内记录；外部消息或通知仍需对应授权。结束或交接前记录真实结果与剩余阻塞，不能用 idle 代替交接。
