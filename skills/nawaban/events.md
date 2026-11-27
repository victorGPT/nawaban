# 事件格式

`nawaban event <票> <类> [正文]`，正文写 `-` 读 stdin。

```
nawaban event <票> note "已完成：<做完什么> / 下一步：<下一步> / 卡点：<卡在哪，或 无>"
nawaban event <票> decision "决定：<选了什么，为什么>
背景：<问题和它取决于的事实>
否决方案：<方案>，<为什么不选>
影响：<后果，可选>"
nawaban event <票> link "pr:<url>"
```

- `note` 是进展同步，每个停手点记一条。分诊标签也是 note：`triage: <标签>`。
- `decision` 是决策记录。人选的加 `--by user`；替决策者定、又动到 KR 的加 `--kr "<O / KR>"`。
- 链接前缀：`pr:`、`commit:`、`artifact:`、`adr:`。

## KR 影响声明

认领时登记，早于第一个 PR 链接：`nawaban claim <票> --o "<O>" --kr "<KR>=toward|away|hold"`。改的是量法或金标时加 `--change measure` 或 `--change gold`，单独计数、不判。关票或 merge 时带 `--kr "<KR>=<后值> 实测|预计"` 报后值。没声明的票，关票锁和 merge 钩子都拒。
