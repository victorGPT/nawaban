---
name: ask
description: "Put a decision in front of the owner as a decision card. Use when only the owner can decide: how the product behaves, what is said outside, what goes to production, an Objective or a KR."
---

Ask the owner by a card on the ticket, never in words alone.

1. Check it is theirs to decide. Anything below a KR you decide yourself and record: `nawaban event <ID> decision "决定：… 背景：… 否决方案：…"`, with `--kr "<O / KR>"` when it serves one.
2. Write the card: the one decision asked; the KR it serves, or 无; only the facts it turns on; two options or more, each with its cost and its door; your recommendation and why.
3. Put the card in your reply as one block, at the top level of the reply:

```json#nawaban-ask-request@1
{ "ticket": "<KEY or #N>", "decision": "<the one decision>", "kr": "<O / KR, or 无>", "context": "<the facts>",
  "options": [ { "choice": "<A>", "tradeoff": "<its cost>", "door": "two-way" },
               { "choice": "<B>", "tradeoff": "<its cost>", "door": "one-way" } ],
  "recommendation": "<which, and why>" }
```

4. End the reply there. The Stop hook records the card on the ticket as a 待决策项 and lets the reply through; a ticket already waiting on the owner is left as it is.
5. When the owner answers, record it: `nawaban event <ID> resolve "<their words>"`.

A field that says nothing (无, -, 待定) sends the reply back; only `kr` may be 无. Show the format without asking by a four-backtick fence. For a fact you need, not a decision: `nawaban event <ID> note "triage: needs-info — 等你：<question>"`. No padding.
