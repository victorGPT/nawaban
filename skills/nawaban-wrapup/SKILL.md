---
name: nawaban-wrapup
description: 结束或交接 nawaban 工作时，检查本 session 未收尾的认领并记录真实交接态。
---

# nawaban 收尾

沿用本次工作的 CLI、目标库和会话身份；不确定时读 [运行入口与身份](../nawaban/references/runtime.md)。相对链接按本 Skill 的真实路径解析。

```bash
nawaban --db <目标库绝对路径> wrapup
```

它检查本 session 尚未结束的认领记录，不是所有活跃卡，也不证明任务已 done。跨 session 接手、已写过 handoff 后又继续工作的情况，还需核对本次实际处理的卡。

按每张卡的真实结果构造 `handoff`：选择一个 outcome，填写 summary、now；CLI 输出是示意模板，含 `|` 占位符且未保留显式 `--db`，不能原样执行。仍需确认交付或归档条件时读 [交付与收尾](../nawaban/references/cards.md)。

```bash
nawaban --db <同一目标库绝对路径> handoff <ID> --outcome handed_off \
  --summary "<已完成、剩余与证据>" --now "<当前状态与下一步>"
```

有已保存的产物时加 `--artifact <实际存在的路径>`；明确交接并放弃 owner 时才加 `--release`。handoff 记录尝试结果，不自动把任务状态改为 done。可在授权范围内完成的剩余工作继续完成；真正阻塞则如实交接。

完成条件：本次处理的卡反映当前状态，产物可访问，未完成项有接手所需信息。
