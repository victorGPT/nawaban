# Triage Labels

The skills speak in terms of canonical triage roles. This repo uses three, under the same names:

| Label             | Meaning                                       |
| ----------------- | --------------------------------------------- |
| `needs-info`      | Waiting on the user to answer or act          |
| `ready-for-agent` | Fully specified, ready for an AFK agent       |
| `ready-for-human` | Requires human implementation                 |

The nawaban board has no label field. To apply a label, record a note event on the task: `nawaban event <ID> --kind note --body "triage: <label>"` (the command is in `docs/agents/issue-tracker.md`). The latest `triage:` note is the task's current label. A task that is `open`, has no `triage:` note and whose blockers are all `done` or `cancelled` counts as `ready-for-agent`.

`needs-info` carries the question: `triage: needs-info — 等你：<one-line question or what the user must do>`. The agent keeps holding the task and asks in the conversation as usual; once the user answers, it records the answer as a decision with `--by user`, then `triage: ready-for-agent`. The `nawaban` skill's "Waiting on the user" section is the full rule.
