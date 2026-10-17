# Creating tasks and scoping

When a task exists, reuse its goal, constraints, and decisions. Authorized work without a task gets one created directly; clarify only when an open fork would change scope, behaviour, or risk. The implementation method, the number of files, or the presence of a UI does not by itself call for a full interview, an ADR, or several tasks.

Split a task when parts need separate delivery, different owners, or an explicit blocking relation. An assumption that is hard to judge statically can get a bounded check first; when it truly blocks the rest, make it a prerequisite task. Follow the project's conventions for terms and architecture decisions, and create no empty document just to satisfy a process.

## Where material goes

| Content | CLI field or action |
|---|---|
| User goal and background | `create --context` or `--context-file`; write-once. Write a Markdown bullet list, one point per bullet, optionally led by a `**label**:` (such as `- **User 2026-09-17**: …`, `- **Background**: …`) |
| Observable completion conditions | `--success`, a JSON array |
| Scope, authorization, and constraints | `--constraints`, a JSON array; each edit path as its own `--touch` |
| Current progress and evidence | `--now`, `event`, `ref`, `handoff` |
| Linked decision or module grouping | `--adr`, `--epic` when needed; append decisions with `decide` |
| Project, when several share a database | Pass `--project` explicitly; without it, a task created with `--split-from` inherits the parent's project |

Look up field details in `nawaban create --help`; there is no body or description field to invent. Revise `success` through `decide`, keeping the reason and the real source of the decision.

A blocking edge is `nawaban --db <target db> link <blocked task> <prerequisite task> --kind depends_on`; `claim` checks the prerequisite's status. Lineage and blocking are different relations: splitting from a task does not make it a prerequisite.

Create an epic map only when it helps coordinate across tasks. It records the goal, pointers to settled decisions, open questions, and scope; concrete facts stay on the tasks or in the project's decision documents.
