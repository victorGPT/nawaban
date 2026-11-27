---
name: ticket
description: "编排者用。在板上开一张票。决策者交来一件活、收件箱条目是活、或红 KR 要人干时用。"
---

决策者交来一件活、收件箱条目是活、或红 KR 要人干时用。标题写做完后人能看到什么；票里不写步骤、设计和该 worker 定的事。

1. **要几个 PR、各部分有先后、或要和同事分工** → 拆成多张。提醒决策者敲 `/grill-with-docs`、`/to-spec`、`/to-tickets`；他不在就自己拆，拆法给他看过再派：
   - 垂直切片：每张打通一条窄而完整的路径，做完能单独验证，一个新会话做得完。
   - 预重构单独成票放最前。宽重构先让新旧并存，按目录分批迁，最后删旧。
   - 读同样文档、改同样目录的票带同一个 `--lane`，先后关系用 `--blocked-by`。
2. **推动某条 KR** → 正文写 O 和 KR。一次性的活、修 bug、改流程和工具不挂 O。
3. **正文写到文件** → 两节 `## What to build`、`## Acceptance criteria`，每条判据是命令或界面能显示的。仓库有 `docs/agents/okr.toml` 时，一条判据是 worker 的 KR 登记：`claim --o "<O>" --kr "<KR>=toward"` 或 `--o 无`。
4. **建票，不认领** → `nawaban create <KEY> --project <p> --title "<标题>" --body-file <文件>`，按需带 `--parent`、`--blocked-by`。

回复：票的那一行，加一行 `O：<O / KR | 无，因为 …>`。
