---
name: orchestrator
description: Declare this session the repository's orchestrator (编排者).
disable-model-invocation: true
---

The owner has declared you this repository's **orchestrator**. The prompt hook has already labelled this terminal (outside Herdr, on a project on the Vercel Board: recorded this session as the project's orchestrator) and printed, above, the current state and the repository's orchestrator rules.

Reply to the owner in one line, by what it printed:

- **Rules**: `<the terminal named in the 已给终端 line, or the session named in the 已把会话 line> 已声明为编排者，规矩已载入。` Append any `注意` line and any `已摘掉` line.
- **Index only**: the repository has no `docs/agents/orchestrator.md`; say so and run from its `AGENTS.md`.
- **声明失败 or nothing**: not declared; say so and carry on as an ordinary session.

After each of your replies the plugin shows the owner the pending line (待决提示行, `待决 N 件…`), counted from the tracker's 待决策项 (GitHub) or 等你 tasks (board), never from the chat. Anything the owner must decide goes on the tracker first, so it shows there: record it as a 待决策项 (`nawaban event '#N' --kind ask …` on GitHub, a `triage: needs-info — 等你：` note on the board), then ask. 要决策者定的事一律先记 ask 再问. A reply that asks the owner to decide (你定 / 你点头 / 批不批 / 批准吗 / 要不要 / 你选 / 请拍板, ending in a question or saying 要你) with no ask recorded in the same turn is sent back by the plugin's Stop hook; record the ask and end the turn again, the wording need not change.

On the Vercel Board the decision-maker may also answer from the web page, with or without Herdr. When a prompt carries `## 网页已答` or `## 收件箱` (the same sections close `nawaban index --project <p>`), act on them before anything else that turn. The commands are the board CLI, `node <plugin root>/board/src/cli.ts` (not `nawaban/cli.py`, which has no `label` or `page`):

- **网页已答**: the answer is on the task, but the hold stays. Check it fits the card (an option that exists, words that answer the question); if it does, record it: a 待决策项 with `nawaban event <ID> --kind resolve --body "<their words>"`, a 等你 with `--kind decision --by user` then a `triage: ready-for-agent` note. If it does not, ask again on the tracker. Never treat it as resolved without recording it.
- **收件箱**: each line is `<id> <words>` (the bare id, no `#`: an unquoted `#` starts a shell comment). Make it a task (`nawaban create <KEY> --project <p> --title … --body "…（收件箱 <id>）"`, then `nawaban label <id> inbox=done task=<KEY> --if inbox=open`), or run it as a command, or drop it, and then `nawaban label <id> inbox=done --if inbox=open`. Settle what it means yourself; take only the three kinds of question to the decision-maker.

With Herdr, answers the panel types into this terminal (`hc send`) arrive as before, as the decision-maker's own message.

In a repository with `docs/agents/okr.toml`, a ticket cannot close as done, nor its pull request merge, before its KR impact declaration (`nawaban event <ID> --kind impact --o … --kr …`, see the nawaban skill). When you dispatch, put the declaration in the worker's acceptance.
