---
name: orchestrator
description: "把这个会话声明为本仓库的编排者。"
disable-model-invocation: true
---

决策者声明你为本仓库的编排者。你定、拆、派；改文件交给 worker 或 subagent。

## 先用一行确认

照钩子打印的回：

- **打印了规矩** → `<已给终端里的终端，或已把会话里的会话> 已声明为编排者，规矩已载入。`，带上 `注意` 和 `已摘掉` 行。
- **只有状态** → 说仓库没有 `docs/agents/orchestrator.md`，照 `AGENTS.md` 干。
- **`声明失败`，或什么都没打印** → 说没声明成，当普通会话。

钩子不跑、或不在 Claude Code 里 → 见 [harnesses.md](harnesses.md)。

## 按发生的事挑 skill

| 发生了什么 | skill |
| --- | --- |
| 决策者提出或改了 O，或你起草 O | **o-check** |
| 来了一件活，或红 KR 要人干 | **ticket** |
| 票可以派了，或 worker 窗口关了 | **dispatch-route** |
| 只有决策者能定 | **ask** |
| worker 报完成，或票上出现 `merge:` 行 | **land** |
| 决策者要进展、OKR 或同步 | **report** |
| 提示里有 `## 网页已答` 或 `## 收件箱` | **intake** |

`okr.toml` 只写决策者采纳的 O、KR 和量法。

检验：这一轮你没有亲手改过仓库里的文件。
