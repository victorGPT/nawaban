---
name: orchestrator
description: Declare this session the repository's orchestrator (编排者).
disable-model-invocation: true
---

The owner has declared you this repository's **orchestrator**. The prompt hook has labelled this terminal and printed, above, the current state and the repository's orchestrator rules. The board CLI is `node <plugin root>/board/src/cli.ts`.

1. Reply in one line, by what the hook printed:
   - **Rules**: `<the terminal named in 已给终端, or the session named in 已把会话> 已声明为编排者，规矩已载入。` plus any `注意` and `已摘掉` line.
   - **Index only**: the repository has no `docs/agents/orchestrator.md`; say so and run from its `AGENTS.md`.
   - **声明失败 or nothing**: not declared; say so and carry on as an ordinary session.
2. Act on a prompt's `## 网页已答` and `## 收件箱` before anything else that turn:
   - **网页已答**: the answer is on the task and the hold stays. When it fits the card (an option that exists, words that answer the question), record it: a 待决策项 with `nawaban event <ID> --kind resolve --body "<their words>"`, a 等你 with `--kind decision --by user` then a `triage: ready-for-agent` note. Otherwise ask again on the tracker.
   - **收件箱**: each line is `<id> <words>`, the bare id (an unquoted `#` starts a shell comment). Make it a task (`nawaban create <KEY> --project <p> --title … --body "…（收件箱 <id>）"`, then `nawaban board label <id> inbox=done task=<KEY> --if inbox=open`), or run it as a command, or drop it, then `nawaban board label <id> inbox=done --if inbox=open`. Settle what it means yourself.
3. Record each thing the owner must decide on the tracker, then ask: a 待决策项 on GitHub (`nawaban event '#N' --kind ask …`), a `triage: needs-info — 等你：` note on the board. The pending line under each reply (`待决 N 件…`) counts only these, and the Stop hook sends back a reply that asks for a decision with no ask recorded that turn.
4. When the owner states or changes an Objective, or you draft one, run the **o-check** skill.
5. When you split tickets, note each one's lane, `lane: <name>`: tickets that load the same docs, change the same directories and use the same tools share one. `nawaban dispatch` hands a lane's next ticket to its running worker; pass `--new` for a ticket that should run in parallel. In a repository with `docs/agents/okr.toml`, put the KR impact declaration in the worker's acceptance: registered as it claims (`nawaban claim <ID> --o … --kr …`), its result reported as it closes (`nawaban close <ID> --done --kr …`).
6. On the board the worker merges with `nawaban merge <PR>`, which closes the ticket and hands it the lane's next ticket or retires it. Elsewhere, when a worker reports 完成 and you close its ticket, dispatch the lane's next ticket; retire the worker only when its lane is empty or dispatch passed it over. The rules are in the nawaban skill's Dispatch section.

Objectives, KRs and how KRs are measured belong to the owner: write into `okr.toml` only what they took.
