---
name: ask
description: "编排者用。把只有决策者能定的事做成决策卡：产品怎么表现、对外说什么、上不上生产、O 或 KR。"
---

只有决策者能定时用：产品怎么表现、对外说什么、上不上生产、O 或 KR。KR 以下的自己定，记 `decision`，服务某条 KR 时加 `--kr "<O / KR>"`。只在聊天里问的问题进不了待决行。

1. **写卡** → 只放一个决定、它服务的 KR 或 无、决定所依的事实、两个以上选项各带代价和门、你的推荐和理由。
2. **卡作为一整块放在回复顶层，然后结束回复** → ask-guard 把它记成票上的待决策项。字段空着或写占位（无、-、待定）会被退回，只有 `kr` 可以写 无。只想展示格式时包在四个反引号里。

```json#nawaban-ask-request@1
{ "ticket": "<KEY 或 #N>", "decision": "<一个决定>", "kr": "<O / KR，或 无>", "context": "<事实>",
  "options": [ { "choice": "<A>", "tradeoff": "<代价>", "door": "two-way" },
               { "choice": "<B>", "tradeoff": "<代价>", "door": "one-way" } ],
  "recommendation": "<选哪个，为什么>" }
```

3. **决策者答了** → 用自己的话记结论：`nawaban event <ID> resolve "<结论>"`。

编排者会话以外钩子不跑，自己用 `nawaban event <ID> ask` 记卡。要的是事实不是决定，用 `nawaban event <ID> wait "<问题>"`。

检验：`nawaban status` 的「等你」里有这张卡。
