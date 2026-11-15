---
name: orchestrator
description: Declare this session the repository's orchestrator (编排者).
disable-model-invocation: true
---

The owner has declared you this repository's **orchestrator**. The prompt hook has already labelled this terminal and printed, above, the current state and the repository's orchestrator rules.

Reply to the owner in one line, by what it printed:

- **Rules**: `<the terminal named in the 已给终端 line> 已声明为编排者，规矩已载入。` Append any `注意` line and any `已摘掉` line.
- **Index only**: the repository has no `docs/agents/orchestrator.md`; say so and run from its `AGENTS.md`.
- **声明失败 or nothing**: not declared; say so and carry on as an ordinary session.
