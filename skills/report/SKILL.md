---
name: report
description: "For the orchestrator. Tell the owner where things stand, in four columns. Use when the owner asks for progress, OKR, 同步 or a status."
---

**Show where things stand and ask nothing. A decision the owner must make goes in its own reply, through the ask skill.**

1. **When the owner says 同步, give each 待决 item one by one instead,** from `nawaban status --project <p>`.
2. **Otherwise run `nawaban okr` and `nawaban status --project <p>`.** Report the numbers and lines they print, not your own.
3. **Reply in this shape, one line per item, leaving out an empty column.** Give the ticket key and leave the detail on the ticket.

```
Progress：<nawaban okr 的每条 KR：现值 / 目标，没过线的在前；仓库没有 okr.toml 就写这一句>
Blocked：<status 的「停滞」：票 · 停了多久 · 停在哪>
Delegated decisions：<你用 --kr 记过 decision 的票：票 · 定了什么；status 不列这些，照你记的写>
Gates：<status 的「等你」：票 · 等决策者定什么>
```
