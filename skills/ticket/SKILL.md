---
name: ticket
description: "For the orchestrator. Open one ticket on the board, with or without an Objective. Use when the owner hands you a piece of work, an inbox note turns out to be work, or a red KR needs a ticket."
---

**Open a ticket whose title says what a person can see once it is done. A ticket holds no steps, no design, and nothing the worker should decide.**

1. **Size it.** Work that takes several pull requests, has an order between its parts, or is shared with a colleague is several tickets. Remind the owner to type `/grill-with-docs`, `/to-spec`, `/to-tickets`. Without their input, split it by hand with the rules in [collaboration](../collaboration/SKILL.md#拆任务规则) and show the split to the owner before any dispatch. Come back here for each ticket.
2. **Decide whether it serves an Objective.** A one-off, a bug fix, or work on the process or the tools serves none. Work that moves a KR serves one: name the O and the KR in the body.
3. **Write the body to a file with `## What to build` and `## Acceptance criteria`.** Each criterion is something a command or a screen can show. In a repository with `docs/agents/okr.toml`, one criterion is the worker's KR registration: `nawaban claim <KEY> --o "<O>" --kr "<KR>=toward"`, or `--o 无`.
4. **Create it and leave it unclaimed.** Run `nawaban create <KEY> --project <p> --title "<title>" --body-file <file>`, with `--parent` and `--blocked-by` where they apply.

**Reply:** the ticket's row and one line, `O：<O / KR | 无，因为 …>`.
