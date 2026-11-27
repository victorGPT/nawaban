# Triage Labels

The skills speak in terms of canonical triage roles. This repo uses three, under the same names:

| Label             | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `needs-info`      | Waiting on the user to answer or act          |
| `ready-for-agent` | Fully specified, ready for an AFK agent       |
| `ready-for-human` | Requires human implementation                 |

The nawaban board has no label field. To apply a label, record a note event on the task: `nawaban event <ID> note "triage: <label>"` (the command is in `docs/agents/issue-tracker.md`). The latest `triage:` note is the task's current label. A task that is `open`, has no `triage:` note and whose blockers are all `done` or `cancelled` counts as `ready-for-agent`.

`needs-info` is `nawaban event <ID> wait "<one-line question or what the user must do>"`: the ticket is held for a person and the agent asks in the conversation as usual; once the user answers, `nawaban event <ID> resolve "<the distilled conclusion>"` lifts the hold and gives the ticket back to the agent that waited. The `nawaban` skill's "Waiting on the user" section is the full rule.
