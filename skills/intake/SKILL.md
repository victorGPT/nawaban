---
name: intake
description: "Handle what the owner wrote on the web page: an answer on a held ticket, or an inbox note. Use when a prompt carries ## 网页已答 or ## 收件箱."
---

Settle each item this turn, before anything else.

1. 网页已答: the answer is on the ticket and the hold stays. Check that it fits what was asked: an option that exists, words that answer the question.
2. It fits a 待决策项: `nawaban event <ID> resolve "<their words>"`. It fits a 等你: `nawaban event <ID> decision "<their words>" --by user`, then `nawaban event <ID> note "triage: ready-for-agent"`. It does not fit: ask again through the **ask** skill.
3. 收件箱: each line is `<id> <words>`, the bare id. Decide what the note is: work, a command, or nothing.
4. Work: open it with the **ticket** skill, with `（收件箱 <id>）` in the body, then `nawaban board label <id> inbox=done task=<KEY> --if inbox=open`.
5. A command: run it. For a command and for nothing: `nawaban board label <id> inbox=done --if inbox=open`.
6. Reply with one line per item: `<id>：<记成已决 | 转成 <KEY> | 已执行 | 不处理，因为 …>`.

The page never records a decision; you do, in the owner's words. No padding.
