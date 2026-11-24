---
name: o-check
description: "Check whether a proposed Objective (O) is one, name the gap, then ask for the missing fact, ask one question, or suggest a rewrite. Use when the decision-maker states or changes an O, or an agent drafts one."
---

Check an Objective's wording before anyone drafts KRs for it. Pass and miss examples for each criterion are in [examples.md](examples.md).

1. Judge the O against six criteria, reading the existing Objectives in the repository's `docs/agents/okr.toml` for the fifth:
   1. 定性、有方向: says where to go, not a number. A number is a KR.
   2. 不是任务或产出: nothing you ship or finish.
   3. 重要、说得出为什么是现在: serves the product's mission or its current focus. An internal O, one a product user never feels, passes.
   4. 能被 KR 量: one or two result KRs come to mind.
   5. 不重叠: no existing O covers it, with the evidence.
   6. 一句话说清.
2. Grade it: 是 O misses nothing; 差一点 misses one criterion that a fact or a rewrite fixes; 不是 O is a number, a task, or an O that already exists.
3. Pick one next step: 请补充 (the missing fact), 反问 (one question), or 改写建议 (one or two rewrites).
4. Reply in this shape:

```
O 体检：<是 O | 差一点 | 不是 O>
差在：<number and name of each missed criterion, or 无>
下一步：<请补充：… | 反问：… | 改写建议：①… ②…>
```

The O is the decision-maker's: write nothing into `okr.toml` until they take a version. No padding.
