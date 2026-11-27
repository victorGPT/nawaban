---
name: report
description: 编排者用。分四栏告诉决策者现在到哪了。决策者要进展、OKR、同步或状态时用。
---

决策者要进展、OKR 或状态时用。只摆事实，不提问；要决策者定的事另起一条回复走 **ask**。

- **决策者说「同步」** → 照 `nawaban status --project <p>` 把每条待决逐条给他。
- **其余** → 跑 `nawaban okr` 和 `nawaban status --project <p>`，报它们打印的数和行，不报你自己估的。每项一行，给票的 KEY，细节留在票上，空栏不写：

```
Progress：<nawaban okr 的每条 KR：现值 / 目标，没过线的在前；仓库没有 okr.toml 就写这一句>
Blocked：<status 的「停滞」：票 · 停了多久 · 停在哪>
Delegated decisions：<你用 --kr 记过 decision 的票：票 · 定了什么；status 不列这些，照你记的写>
Gates：<status 的「等你」：票 · 等决策者定什么>
```
