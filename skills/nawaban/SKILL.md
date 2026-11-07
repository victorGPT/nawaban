---
name: nawaban
description: The nawaban board is the issue tracker. Use when a skill says to publish a spec, "publish the tickets" or "fetch the ticket" (each ticket is a task), or to find the frontier; before working on a task; and when recording a note, a decision between options, or a link such as a pull request.
---

# nawaban issue tracker

A nawaban board records **tasks** and an append-only **event** log per task. It holds no workflow: the engineering skills (`/to-spec`, `/to-tickets`, `/implement-spec`, `tdd`, `code-review`) decide what to do; the board records what was decided and done.

## Rules

1. **Three questions for the user.** Bring the user only questions about how the product should behave, what is said to the outside, and whether something goes to production. Settle every other choice yourself. A step the running skill marks as the user's (approving the split in `/to-tickets`, confirming the seam in `/to-spec`, `grilling`, a wayfinder HITL ticket) goes to the user as written; this rule governs only the choices outside those steps.
2. **Every choice becomes a decision event.** Whenever you choose between options, record it (see "Record events"), including the user's answers to the three questions above.
3. **Claim before work.** Claim a task before working on it, and close or release it when you stop.

## The command

The CLI is `nawaban/cli.py` in the plugin root, two directories above this skill's base directory. Below, `nawaban` stands for:

```
python3 <plugin root>/nawaban/cli.py --db <absolute board path>
```

Use the board the project names (its `CLAUDE.md` or `docs/agents/issue-tracker.md`); otherwise the CLI finds `.nawaban/nawaban.db` in the repository's main checkout. Always pass the absolute `--db`, also from worktrees, so every worktree writes one board. Write the whole command out in every call. Do not keep it in a shell variable (`N="python3 ..."; $N list`): a subagent's Bash refuses a command whose name is computed at runtime, and zsh does not split the variable. `nawaban <verb> --help` lists a verb's flags. Output is in Chinese: `✓` is success; `✗` with exit 1 is a refusal or an unknown id.

Identity comes from `CLAUDE_CODE_SESSION_ID`, then `NAWABAN_OWNER`. A session without either (Codex) sets `NAWABAN_OWNER` to a stable name before claiming or writing events.

## Task shape

- **id**: any string without whitespace, e.g. `LEAN` or `LEAN-03`.
- **title**: what a person can see once it is done.
- **body**: markdown. A task's body has two sections, `## What to build` and `## Acceptance criteria`; a spec task's body is the whole spec. Write the body to a file and pass `--body-file`.
- **project**: defaults to the parent's project, then to the git repository the command runs in (its main checkout, also from a worktree), then to the repository holding the board. Pass `--project` only to override.
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
- `nawaban json projects`, `nawaban json board [--project <name>]`, `nawaban json task <ID>`: the JSON the Herdr panel reads, on stdout, read-only. An unknown id or a missing board prints `{"error": ...}` on stdout and exits 1.

## Index: read it first

As a leader, run `nawaban index` when you start and again after your context is compacted, before you rebuild what is going on from memory. It prints, from the same data as `json board` (the repository's GitHub issues when its `docs/agents/issue-tracker.md` names GitHub, else the board; `--project <name>` on the board), an md index on stdout: what waits on the user (等你), what has had no activity for 24 hours and on whom it stopped (停了), what moves (在推), each with the spec it belongs to, its latest progress and its next step, or the decision that came after that step; the user's decisions of the last 48 hours (on GitHub, a `决定：` that says `拍板` or names one of the comma-separated `NAWABAN_OWNER_NAMES`); what nobody has touched; and how many closed. It writes nothing.

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

## Dispatch tasks to Herdr workers

When the user asks you to dispatch tasks, you are the leader: hold no task yourself and keep task detail on the board, not in your context. Before starting each worker, record `nawaban event <ID> --kind note --body "dispatch: <name>"`: the author of a task's latest `dispatch:` note is its leader, and the Herdr panel groups the task under you by it. Each worker reports back with one line, `'<ID> done'` or `'<ID> blocked: <question>'`, sent with SendMessage to `<leader>`, the name `ListAgents` says other sessions use for you. Progress is `nawaban show <ID>`.

### In the Herdr app or herdr-core (`HC_TERMINAL_ID` is set)

For each task `<ID>`, with `<name>` its id in lowercase (1 to 32 of `a-z 0-9 - _`, unique among live terminals):

    git -C <repo> worktree add <repo>/.claude/worktrees/<name> -b feat/<name>
    hc run --bg --outlive-parent --name <name> --cwd <repo>/.claude/worktrees/<name> claude "Work nawaban task <ID>: claim it, build it, record events, close it. When done or blocked, SendMessage <leader> one line: '<ID> done' or '<ID> blocked: <question>'."

Keep the worktree under `<repo>/.claude/worktrees/`: a folder Claude Code has not trusted stops the worker at a trust prompt. `--outlive-parent` keeps workers running when your session ends. Claude Code reports no status to herdr-core, so the sidebar shows none for workers: take the worker's message and the board as the signal that a task is finished. Once the task is closed, `hc kill <name>` and `git -C <repo> worktree remove <repo>/.claude/worktrees/<name>`; the branch stays.

### In Herdr TUI (`HERDR_ENV=1`)

For each task `<ID>`, with `<name>` its id in lowercase (herdr agent names are `[a-z][a-z0-9_-]`):

    herdr worktree create --cwd <repo> --branch feat/<name> --label <ID> --no-focus
    herdr agent start <name> --kind claude --pane <root pane id from the create output>
    herdr agent prompt <name> "Work nawaban task <ID>: claim it, build it, record events, close it. When done or blocked, SendMessage <leader> one line: '<ID> done' or '<ID> blocked: <question>'."

Live status is the herdr sidebar. herdr's `agent_status` can read `done` while a worker is still working, so take the worker's message and the board as the signal that a task is finished. Once the task is closed, `herdr worktree remove --workspace <workspace id>`; the branch stays.

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

## Waiting on the user

When the work needs the user to answer or act, ask in the conversation as usual and record

```
nawaban event <ID> --kind note --body "triage: needs-info — 等你：<one-line question or what the user must do>"
```

Keep holding the task. The Herdr panel shows it under 等你 with that line. Once the user answers, record the answer as a decision with `--by user`, then a note `triage: ready-for-agent`.

## Wayfinder maps

A wayfinder map is a parent task with a note `wayfinder: map`. The board has no command that edits a body, so the map's body stays as first written and its events carry the changes:

- A ticket is `nawaban create <ID> --parent <MAP>` plus a note `wayfinder: <type>`, with no `triage:` prefix. A ticket blocking another is `nawaban block`. The frontier is `nawaban list --parent <MAP> --frontier`.
- Resolving a ticket:
  1. Record its full conclusion as a decision on the ticket, and a note on the map `decided: <ticket ID> <ticket title>: <one-line conclusion>`. These notes are the map's Decisions so far.
  2. A research ticket: a link `commit:<sha on the research branch>`, then `close --done`.
  3. A grilling ticket: `close --done` after its decision.
  4. A ticket out of scope: `close --cancelled`, and a note on the map `out-of-scope: …`.
- Fog that becomes a ticket: a note on the map `graduated: <fog> → <new ticket ID>`.
- Removing a ticket: `close --cancelled` plus a note with the reason.

## Back up

- `nawaban backup`: copy the board into `backups/` beside it with a timestamp; copies older than 14 days are pruned. Run it before risky changes.
- `nawaban init`: create an empty board, only when connecting a new project.
