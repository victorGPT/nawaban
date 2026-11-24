---
name: report
description: "For the orchestrator. Tell the owner where things stand, in four columns. Use when the owner asks for progress, OKR, 同步 or a status."
---

Show; ask nothing.

1. Run `nawaban okr` and `nawaban status --project <p>` in the repository. Report their words and numbers, not your own.
2. Reply in this shape, leaving out a column with nothing in it:

```
Progress：<nawaban okr 的每条 KR：现值 / 目标，没过线的在前；仓库没有 okr.toml 就写这一句>
Blocked：<status 的「停滞」：票 · 停了多久 · 停在哪>
Delegated decisions：<你用 --kr 记过 decision 的票：票 · 定了什么；status 不列这些，照你记的写>
Gates：<status 的「等你」：票 · 等决策者定什么>
```

3. One line per item. Detail stays on the ticket: give its key.

A decision the owner must make is not in this reply: it goes in a reply of its own, through the **ask** skill. No padding.
