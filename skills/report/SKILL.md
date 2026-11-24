---
name: report
description: "Tell the owner where things stand, in four columns. Use when the owner asks for progress, OKR, 同步 or a status."
---

Show; ask nothing.

1. Run `nawaban okr` and `nawaban status --project <p>` in the repository. Report their numbers, not your own.
2. Reply in this shape, leaving out a column with nothing in it:

```
Progress：<每条 KR：现值 / 目标 · 红|黄|绿，红的在前>
Blocked：<票 · 卡在谁那 · 从什么时候>
Delegated decisions：<只列挂了 KR 的：票 · 你定了什么>
Gates：<等决策者点头的硬闸：部署、读生产数据、改 KR>
```

3. One line per item. Detail stays on the ticket: give its key.

A decision the owner must make is not in this reply: it goes in a reply of its own, through the **ask** skill. No padding.
