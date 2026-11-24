---
name: ticket
description: "Open one ticket on the board, with or without an Objective. Use when the owner hands you a piece of work, an inbox note turns out to be work, or a red KR needs a ticket."
---

Open a ticket whose title says what a person can see once it is done.

1. Size it. Work that takes several pull requests, has an order between its parts, or is shared with a colleague is not one ticket: run `grilling`, then `/to-spec` and `/to-tickets`, and come back here for each ticket they produce.
2. Decide whether it serves an Objective. It serves none when it is a one-off, a bug fix, or work on the process or the tools. It serves one when it moves a KR: name the O and the KR in the body.
3. Write the body to a file, in two sections: `## What to build` and `## Acceptance criteria`, each criterion something a command or a screen can show.
4. Create it: `nawaban create <KEY> --project <p> --title "<title>" --body-file <file>`, with `--parent <KEY>` and `--blocked-by <KEY>` where they apply.
5. In a repository with `docs/agents/okr.toml`, put the registration in the acceptance: `nawaban claim <KEY> --o "<O>" --kr "<KR>=toward"` for a ticket that serves a KR, `nawaban claim <KEY> --o 无` for one that serves none.
6. Reply with the ticket's row and one line: `O：<O / KR | 无，因为 …>`.

A ticket is not a plan: no steps, no design, nothing the worker should decide. No padding.
