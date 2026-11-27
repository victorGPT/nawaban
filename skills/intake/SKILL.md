---
name: intake
description: "For the orchestrator. Handle what the owner wrote on the web page: an answer on a held ticket, or an inbox note. Use when a prompt carries ## 网页已答 or ## 收件箱."
---

**Settle every item this turn, before anything else. The page records no decision, so you record it.**

1. **网页已答: check the answer.** The page wrote it on the ticket and left the hold on. It fits when it names an option that exists, or its words answer the question.
2. **Record a fitting answer as its conclusion, in your own words.** Run `nawaban event <ID> resolve "<结论>"`, for a 待决策项 and a 等你 alike. When it does not fit, ask again through the **ask** skill.
3. **收件箱: sort each note.** Each line is `<id> <words>`. Decide whether the note is work, a command, or nothing.
4. **Turn work into a ticket.** Open it through the **ticket** skill with `nawaban create <KEY> --title … --inbox <id>`. The `--inbox` flag marks the note done. Use `nawaban create`, not `board tasks create`, which leaves a 票 with no key that the board never shows.
5. **Run a command, then close the note.** For a command and for nothing, run `nawaban board label <id> inbox=done --if inbox=open`.

**Reply:** one line per item, `<id>：<记成已决 | 转成 <KEY> | 已执行 | 不处理，因为 …>`.
