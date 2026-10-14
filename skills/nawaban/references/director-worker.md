# Worker protocol

Load this only when this session is a worker dispatched by a director, or the project explicitly adopts this protocol; ordinary user tasks follow the [main flow](../SKILL.md).

## Arriving

Read the task first. A `skills:` entry in `constraints` names a capability already chosen for this task; resolve it by the currently enabled name. Pick methods from the goal: writing-for-agents for skill text; domain modelling, ADRs, prototypes, TDD, or deploy notes only when the work actually needs them.

This session was started by `nawaban dispatch`, and its directory is already the task's worktree; do not create another. Once the task is finished or handed off, the director runs `nawaban dismiss` to stop the session and remove the worktree; it leaves a worktree with uncommitted or unpushed changes in place. Commit, push, and opening a PR each still need authorization from the task or the dispatch brief: do what that authorization covers before stopping, leave the rest in the worktree, and say what was left in your report. Never start a named sub-agent as a worker from inside a worker; use sub-agents only for searching code and for review.

## Reporting

Use the same target database and the real session identity:

- Stage progress: `nawaban --db <target db> notify <ID> --kind stage --msg "<result, evidence, and next step>"`.
- A specific blocker: send a `blocked` notification stating the facts and the action needed; keep doing any work that can proceed independently.
- Acceptance: verify the task's `success` item by item and register the actual `acceptance_run` and the reviewed version; report `done` only when every item is met.
- The user must act: submit material through `ask`; report status with `notify`. Neither replaces the other.
- Scope growth: name the paths and the reason in a `blocked` notification; edit only after authorization covering the change arrives and the `scope` change is on the board. Reuse authorization you already have instead of asking again.

A local `nawaban notify` is a record on the board; outside messages or notifications still need their own authorization. Before stopping or handing off, record the real result and any remaining blocker; going idle is not a handoff.

## Reports and replies when a worker stops

Each time a worker started by `dispatch` stops, the last message of its turn is sent to the session that dispatched it and wakes that session; nobody needs to watch the worker's pane or run a listener. Each message carries at most 1500 characters; longer text is truncated with a note, and the full text is in the task's notifications (`notifications --task <ID>`).

When the director receives a report:

- Progress or completion only: no reply needed. Whether the task is done is still decided by its status and its `done` notification.
- The worker left a question the director can settle (implementation choice, a trade-off inside scope, which step comes first, whether to wait for a check): reply with `nawaban --db <target db> notify <ID> --kind reply --msg "<decision and reason>"`. The worker wakes up and continues.
- A product-semantics fork, an external commitment, or a production release: the director does not answer these. It hands the material to the user through `ask`, then tells the worker the question went to the user and to do the work that does not depend on it.

On the worker side: put whatever the director must decide in the last message before stopping, with your recommendation, and stop instead of waiting in the pane. The director's reply appears directly in the worker's session.

Reports are sent only for workers whose dispatch record names a director session, and a reply is accepted only from the session that dispatched the worker; a session the user opened sends nothing when it stops. After `dismiss`, nothing is sent and nothing waits. If the director session changes (the window was reopened), it no longer receives the old workers' reports; read the task's notifications instead.
