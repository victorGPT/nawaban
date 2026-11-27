---
name: dispatch-route
description: "Decide who does a ticket: a running worker, the back of its queue, or a new one. Use before every dispatch, and when a worker's window has closed with a ticket still assigned to it."
---

**Route a ticket by the rules first, then by the state of the agent the rules name. One worker too many or too few is cheap, so decide fast.**

1. **Start a new agent when the ticket checks someone else's work** (review, acceptance, an adversary, a second opinion), or needs another model, repository, or permission.
2. **Otherwise find the agent the ticket belongs to.** Judge by the 改动范围 in the brief, else by the parent ticket or the ticket it came from. The ticket belongs to an agent when it reads the same docs and changes the same directories, follows that agent's own output (review fixes, the next ticket of its split, work its report proposed), or needs state that agent holds (a checkout, uncommitted changes, a running process). When two agents fit, pick the one with its hands on the files. With no such agent, start a new one.
3. **Read that agent's state with `hc get <terminal>`.** Open and idle, or waiting on the owner: give it the ticket. Working: queue the ticket behind it, unless the ticket cannot wait and touches none of its files. Closed, or compacted and past about 40 turns: start a new agent with the ticket's 进展 and branch as the handoff.
4. **Give a running agent the ticket by assignment, never by a message.** `nawaban dispatch <ticket> --to <terminal>` assigns it, and the agent claims it once its current ticket is done. Queueing behind a working agent is the same command.
5. **Otherwise run `nawaban dispatch <ticket>`.** It routes by itself: to the lane's running worker, else to the worker whose changes touch a path the brief names, else to a new one. It passes over a worker on another agent or model, or past half its context. Write the 改动范围 as file paths so it can match them. Pass `--new` or `--to` only when the rules above disagree with it. Hold no 票 yourself while you dispatch.
6. **When the assigned agent has closed its window, return the ticket to the pool first.** Run `nawaban board tasks assign <id> --pool` with the board number `nawaban show` prints, then dispatch with `--new`.
7. **Write the acceptance as `--check '<command>'` wherever a command can prove it.** A `--check` holds only what CI cannot cover, such as an end-to-end probe or a read-only check against the real environment. A code ticket puts no vitest there.
8. **Open the brief with the verdict, and note the same line on the ticket.** `派发判断：<规则命中什么>，<哪个 agent、什么状态> → <指派给它 | 排在它后面 | 新开>`. A ticket without that line was not routed.
