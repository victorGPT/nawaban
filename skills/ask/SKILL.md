---
name: ask
description: "For the orchestrator. Put a decision in front of the owner as a decision card. Use when only the owner can decide: how the product behaves, what is said outside, what goes to production, an Objective or a KR."
---

**Ask the owner with a decision card on the ticket. A question asked only in chat never reaches the pending line.**

1. **Check that the decision is the owner's.** Decide anything below a KR yourself and record it as a `decision` event, with `--kr "<O / KR>"` when it serves one. The event format is in the [nawaban skill](../nawaban/SKILL.md#record-events).
2. **Write the card.** It holds one decision, the KR it serves or 无, only the facts the decision turns on, two or more options each with its cost and its door, and your recommendation with its reason.
3. **Put the card at the top level of your reply as one block, then end the reply.** The ask-guard Stop hook records it on the ticket as a 待决策项, and leaves a ticket already waiting on the owner as it is. It sends the reply back when a field is empty or a placeholder such as 无, -, or 待定. Only `kr` may be 无. To show the format without asking, wrap the block in a four-backtick fence.

```json#nawaban-ask-request@1
{ "ticket": "<KEY or #N>", "decision": "<the one decision>", "kr": "<O / KR, or 无>", "context": "<the facts>",
  "options": [ { "choice": "<A>", "tradeoff": "<its cost>", "door": "two-way" },
               { "choice": "<B>", "tradeoff": "<its cost>", "door": "one-way" } ],
  "recommendation": "<which, and why>" }
```

4. **When the owner answers, record the conclusion in your own words.** Run `nawaban event <ID> resolve "<结论>"`.

Outside the orchestrator session the hook does not run. Record the card yourself with `nawaban event <ID> ask`, whose flags `nawaban event --help` lists. When you need a fact, not a decision, run `nawaban event <ID> wait "<question>"`.
