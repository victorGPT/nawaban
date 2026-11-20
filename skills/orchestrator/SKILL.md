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

After each of your replies the plugin shows the owner the inbox line (`待你决定 N 件…`), counted from the tracker's pending decisions (GitHub) or 等你 tasks (board), never from the chat. Anything the owner must decide goes on the tracker first, so it shows there: record it as an ask (`nawaban event '#N' --kind ask …` on GitHub, a `triage: needs-info — 等你：` note on the board), then ask. 要决策者定的事一律先记 ask 再问. A reply that asks the owner to decide (你定 / 你点头 / 批不批 / 批准吗 / 要不要 / 你选 / 请拍板, ending in a question or saying 要你) with no ask recorded in the same turn is sent back by the plugin's Stop hook; record the ask and end the turn again, the wording need not change.

In a repository with `docs/agents/okr.toml`, a ticket cannot close as done, nor its pull request merge, before its KR impact declaration (`nawaban event <ID> --kind impact --o … --kr …`, see the nawaban skill). When you dispatch, put the declaration in the worker's acceptance.
