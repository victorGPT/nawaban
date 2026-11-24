---
name: dispatch-route
description: "Decide who does a ticket: a running worker, the back of its queue, or a new one. Use before every dispatch, and when a worker's window has closed with a ticket still assigned to it."
---

Route a ticket by the rules first, then by the state of the agent the rules name.

1. A new agent, whatever else holds: the ticket checks someone else's work (review, acceptance, an adversary, a second opinion), or it needs another model, repository or permission.
2. Otherwise find the agent it belongs to. Judge by the 改动范围 in the brief, else by the parent ticket or the ticket it came from. When two agents fit, the one with its hands on the files wins:
   - it reads the same docs and changes the same directories as that agent's work;
   - it follows that agent's own output: review fixes, the next ticket of its split, the work its own report proposed;
   - it needs state that agent holds: a checkout, uncommitted changes, a running process.
3. No such agent: a new one.
4. Read that agent's state with `hc get <terminal>`:
   - open, and idle or waiting on the owner: give it the ticket;
   - working: queue the ticket behind it. Open a new agent only when the ticket cannot wait and touches none of the files in that agent's hands;
   - closed, or compacted and past about 40 turns: a new agent, with the handoff (the ticket's 进展 and its branch).
5. For a running agent, assign the ticket: `nawaban board tasks assign <id> <profile>`, the profile being `cc-` plus the first 8 characters of `revive.session` in `hc get`. The board then keeps the ticket for that profile and gives it out before anything from the pool.
6. Deliver with `nawaban dispatch <ticket> --to <terminal>`, or `--new` for a new agent. Open the brief with the verdict in one line, and note the same line on the ticket: `派发判断：<规则命中什么>，<哪个 agent、什么状态> → <交给它 | 排在它后面 | 新开>`.

A ticket without that line was not routed. One worker too many or too few is cheap; do not deliberate. No padding.
