---
name: nawaban
description: The nawaban board is the issue tracker. Use when a skill says to publish a spec, "publish the tickets" or "fetch the ticket" (each ticket is a task), or to find the frontier; before working on a task; and when recording a note, a decision between options, or a link such as a pull request.
---

# nawaban issue tracker

A nawaban board records **tasks** and an append-only **event** log per task. It holds no workflow: the engineering skills (`/to-spec`, `/to-tickets`, `/implement-spec`, `tdd`, `code-review`) decide what to do; the board records what was decided and done.

## Rules

1. **Three questions for the user.** Bring the user only questions about how the product should behave, what is said to the outside, and whether something goes to production. Settle every other choice yourself.
2. **Every choice becomes a decision event.** Whenever you choose between options, record it (see "Record events"), including the user's answers to the three questions above.
3. **Claim before work.** Claim a task before working on it, and close or release it when you stop.

## The command

The CLI is `nawaban/cli.py` in the plugin root, two directories above this skill's base directory. Below, `nawaban` stands for:

```
python3 <plugin root>/nawaban/cli.py --db <absolute board path>
```

Use the board the project names (its `CLAUDE.md` or `docs/agents/issue-tracker.md`); otherwise the CLI finds `.nawaban/nawaban.db` in the repository's main checkout. Always pass the absolute `--db`, also from worktrees, so every worktree writes one board. `nawaban <verb> --help` lists a verb's flags. Output is in Chinese: `✓` is success; `✗` with exit 1 is a refusal or an unknown id.

Identity comes from `CLAUDE_CODE_SESSION_ID`, then `NAWABAN_OWNER`. A session without either (Codex) sets `NAWABAN_OWNER` to a stable name before claiming or writing events.

## Task shape

- **id**: any string without whitespace, e.g. `LEAN` or `LEAN-03`.
- **title**: what a person can see once it is done.
- **body**: markdown. A task's body has two sections, `## What to build` and `## Acceptance criteria`; a spec task's body is the whole spec. Write the body to a file and pass `--body-file`.
- **project**: defaults to the parent's project, then to the repository holding the board. Pass `--project` only to override.
- **status**: `open`, `done` or `cancelled`. "In progress" is derived: an open task held by a session.

## Publish a spec

```
nawaban create <SPEC-ID> --title "<title>" --body-file <spec.md>
```

## When a skill says "publish the tickets"

Create one task per ticket, blockers first:

```
nawaban create <SPEC-ID>-<NN> --title "<title>" --parent <SPEC-ID> --body-file <task.md> --blocked-by <ID> --blocked-by <ID>
nawaban block <ID> <blocker ID>
```

`block` adds an edge afterwards. Both refuse unknown ids, a task blocking itself, and cycles. Leave the spec task unchanged.

## When a skill says "fetch the ticket": fetch a task or a spec

- `nawaban show <ID>`: title, status, project, parent, holding session, current progress (the latest note, shown for open tasks only), the tasks it is blocked by and its dependents with their status, the body, and the latest 20 events.
- `nawaban list --parent <SPEC-ID>`: every task of a spec, one line each: `<id>  <status>  <project>  <title>`. `nawaban list --project <name>` filters by project.

## Frontier

```
nawaban list --parent <SPEC-ID> --frontier
```

The frontier is every open task that no session holds and whose blockers are all done or cancelled. Without `--parent`, the list includes spec tasks too. Nothing stops a claim on a task outside the frontier; check it yourself.

## Claim, release, close

- `nawaban claim <ID>`: the task becomes yours. A task held by another session is refused with the holder's session id; take it over only on purpose, with `--take`, which is logged. A done or cancelled task is refused; reopen it with `close --reopen` first.
- `nawaban claim <ID> --release`: hand back a task you will not finish; it returns to the frontier. Record a note on where you stopped first.
- `nawaban close <ID> --done` once its work is merged into the integration branch, after a link event for the pull request or commit. `--cancelled` for work dropped; `--reopen` for a task closed by mistake. Closing clears the session.

Every claim, takeover, release and close writes a status event by itself.

## Record events

```
nawaban event <ID> --kind note --body "<progress or handoff>"
nawaban event <ID> --kind decision --body "Question: <question>
Verdict: <what was chosen and why>
Rejected: <option> - <why not>"
nawaban event <ID> --kind link --body "pr:<url>"
```

- A note is the progress line others see; record one at each stopping point.
- A decision the user made gets `--by user`; without it the author is your identity.
- Link prefixes: `pr:`, `commit:`, `artifact:`, `adr:`.
- Triage labels are notes: `--kind note --body "triage: <label>"`.

## Back up and migrate

- `nawaban backup`: copy the board into `backups/` beside it with a timestamp; copies older than 14 days are pruned. Run it before risky changes.
- `nawaban migrate <old board> <new board>`: build a new board from an old-schema board. It never writes the old file and refuses when the new board already holds tasks.
- `nawaban init`: create an empty board, only when connecting a new project.
