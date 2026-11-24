---
name: ticket
description: "For the orchestrator. Open one ticket on the board, with or without an Objective. Use when the owner hands you a piece of work, an inbox note turns out to be work, or a red KR needs a ticket."
---

Open a ticket whose title says what a person can see once it is done.

1. Size it. Work that takes several pull requests, has an order between its parts, or is shared with a colleague is not one ticket. Remind the owner to type `/grill-with-docs`, `/to-spec`, `/to-tickets`; without their input do the same by hand: `grilling`, the spec as a ticket, child tickets with `--parent` and `--blocked-by`, the split shown to the owner before any dispatch. Come back here for each ticket.
2. Decide whether it serves an Objective. It serves none when it is a one-off, a bug fix, or work on the process or the tools. It serves one when it moves a KR: name the O and the KR in the body.
3. Write the body to a file, in two sections: `## What to build` and `## Acceptance criteria`, each criterion something a command or a screen can show. In a repository with `docs/agents/okr.toml`, one criterion is the registration its worker makes as it claims: `nawaban claim <KEY> --o "<O>" --kr "<KR>=toward"`, or `nawaban claim <KEY> --o 无` for a ticket that serves none.
4. Create it and leave it unclaimed: `nawaban create <KEY> --project <p> --title "<title>" --body-file <file>`, with `--parent <KEY>` and `--blocked-by <KEY>` where they apply.
5. Reply with the ticket's row and one line: `O：<O / KR | 无，因为 …>`.

A ticket is not a plan: no steps, no design, nothing the worker should decide. No padding.
