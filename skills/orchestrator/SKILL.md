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
   - **网页已答**: the answer is on the task and the hold stays. When it fits the card (an option that exists, words that answer the question), record it: a 待决策项 with `nawaban event <ID> resolve "<their words>"`, a 等你 with `nawaban event <ID> decision … --by user` then a `triage: ready-for-agent` note. Otherwise ask again on the tracker.
   - **收件箱**: each line is `<id> <words>`, the bare id (an unquoted `#` starts a shell comment). Make it a task (`nawaban create <KEY> --project <p> --title … "…（收件箱 <id>）"`, then `nawaban board label <id> inbox=done task=<KEY> --if inbox=open`), or run it as a command, or drop it, then `nawaban board label <id> inbox=done --if inbox=open`. Settle what it means yourself.
3. When the owner must decide, put one `json#nawaban-ask-request@1` block in your reply, at its top level (not in a list or a quote): the ticket and the decision card.

   ```json#nawaban-ask-request@1
   {
     "ticket": "NAWABAN-12",
     "decision": "详情页先上只读版，还是等编辑功能一起上",
     "kr": "O1 / 决策者每周拍板轮数",
     "context": "只读版今天能合；编辑还差两张票，预计周五",
     "options": [
       { "choice": "先上只读版", "tradeoff": "多发一次版", "door": "two-way" },
       { "choice": "等编辑一起上", "tradeoff": "晚三天拿到反馈", "door": "two-way" }
     ],
     "recommendation": "先上只读版：能撤，早三天拿到反馈"
   }
   ```

   The Stop hook records it on that ticket as a 待决策项, the same as `nawaban event <ID> ask` (on GitHub, `nawaban event '#N' --kind ask`), and lets the reply through; a ticket already waiting on the owner is left as it is. It sends the reply back only when the block doesn't match the schema, a field says nothing (无, -, 待定), the ticket doesn't exist, or the ask can't be recorded. It reads nothing else, so a question asked in words alone is on no tracker, and the pending line under each reply (`待决 N 件…`) counts only what is. To show the format without asking, put it in a four-backtick fence. A question for facts rather than a decision is still a `triage: needs-info — 等你：` note on the board.
4. When the owner states or changes an Objective, or you draft one, run the **o-check** skill.
5. Before every dispatch, run the **dispatch-route** skill: it says whether the ticket goes to a running worker, behind one, or to a new one, and gives the verdict line the brief opens with. In a repository with `docs/agents/okr.toml`, put the KR impact declaration in the worker's acceptance: registered as it claims (`nawaban claim <ID> --o … --kr …`), its result reported as it closes (`nawaban close <ID> --done --kr …`).
6. On the board the worker merges with `nawaban merge <PR>`, which closes the ticket and hands it the lane's next ticket or retires it. Elsewhere, when a worker reports 完成 and you close its ticket, dispatch the lane's next ticket; retire the worker only when its lane is empty or dispatch passed it over. The rules are in the nawaban skill's Dispatch section.

Objectives, KRs and how KRs are measured belong to the owner: write into `okr.toml` only what they took.
