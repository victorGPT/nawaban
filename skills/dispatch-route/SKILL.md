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
5. A running agent, idle or working, gets the ticket by assignment, never by a message: the board keeps an assigned ticket for that agent's profile and gives it out before anything in the pool, and the agent claims it itself once its current ticket is done (`nawaban merge` does, or `nawaban claim --ready`). `nawaban merge` takes only a ticket assigned to the agent, so a ticket left unassigned waits for you. Queueing behind a working agent is the same assignment.
6. Deliver. `nawaban dispatch <ticket>` routes by itself (自动路由): to the running worker of the ticket's lane, else, with no lane, to the running worker whose changes (`git diff origin/main...HEAD` plus uncommitted files) touch a path the brief names, else to a new one. It passes over a worker on another agent or model, or past half its context. Write the paths of the 改动范围 into the brief so it can match them. On a GitHub-tracked repository `cli.py dispatch '#N'` asks the board the same question with `nawaban route`, then sends the running worker the brief and notes `派给 hc <terminal>` on the issue. Override with `--to <terminal>` or `--new` only when the rules above disagree with it. For a running agent, `nawaban dispatch <ticket> --to <terminal>`: it assigns the ticket (`board tasks assign <id> <profile>`, the profile read off the terminal's `revive.agent` and `revive.session` labels), records the dispatch and the brief on the ticket, and sends nothing. For a new agent, `--new`. When the agent a ticket is assigned to has closed its window, first return the ticket to the pool, `nawaban board tasks assign <id> --pool` (`<id>` the board number `nawaban show` prints), since an assigned ticket refuses any other profile's claim, then `--new`. Write the acceptance as `--check '<command>'` wherever a command can prove it; `merge` runs those with the board's `tasks run` and merges only when all exit 0. A `--check` holds only what CI cannot cover: an end-to-end probe, a read-only check against the real environment. A code ticket puts no vitest there: CI runs the tests, and `merge` already waits for CI green. Open the brief with the verdict in one line, and note the same line on the ticket: `派发判断：<规则命中什么>，<哪个 agent、什么状态> → <指派给它 | 排在它后面 | 新开>`.

A ticket without that line was not routed. One worker too many or too few is cheap; do not deliberate. When this repository has more than 8 live workers, dispatch prints a warning: retire finished ones and hand small tickets to a worker already on the same files. No padding.
