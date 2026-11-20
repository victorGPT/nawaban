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

After each of your replies the plugin shows the owner the inbox line (`待你决定 N 件…`), counted from the tracker's pending decisions (GitHub) or 等你 tasks (board), never from the chat. Anything the owner must decide goes on the tracker first, so it shows there.

In a repository with `docs/agents/okr.toml`, a ticket cannot close as done, nor its pull request merge, before its KR impact declaration (`nawaban event <ID> --kind impact --o … --kr …`, see the nawaban skill). When you dispatch, put the declaration in the worker's acceptance.
