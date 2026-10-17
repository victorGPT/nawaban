# Worker protocol

Load this only when this session is a worker dispatched by a director, or the project explicitly adopts this protocol; ordinary user tasks follow the [main flow](../SKILL.md).

## Arriving

Read the task first. A `skills:` entry in `constraints` names a capability already chosen for this task; resolve it by the currently enabled name. Pick methods from the goal: writing-for-agents for skill text; domain modelling, ADRs, prototypes, TDD, or deploy notes only when the work actually needs them.

This session was started by `nawaban dispatch`, and its directory is already the task's worktree; do not create another. Once the task is finished or handed off, the director runs `nawaban dismiss` to stop the session and remove the worktree; it leaves a worktree with uncommitted or unpushed changes in place. Commit, push, and opening a PR each still need authorization from the task or the dispatch brief: do what that authorization covers before stopping, leave the rest in the worktree, and say what was left in your report. Never start a named sub-agent as a worker from inside a worker; use sub-agents only for searching code and checking your own work. The review that gates the merge comes from a separately dispatched review worker, never from this session.

## Reporting

Use the same target database and the real session identity:

- Stage progress: `nawaban --db <target db> notify <ID> --kind stage --msg "<result, evidence, and next step>"`.
- A specific blocker: send a `blocked` notification stating the facts and the action needed; keep doing any work that can proceed independently. Do not also mark yourself blocked in Herdr (`herdr pane report-agent --state blocked`): Herdr then rejects every `herdr agent prompt` to your pane, and that is one of the ways the director's reply reaches you.
- Acceptance: verify the task's `success` item by item and register the actual `acceptance_run` and the reviewed version; report `done` only when every item is met.
- Before handing in a PR for review: merge the latest `main` into the branch and push, wait for green CI, and register the PR with `ref <ID> --kind pr --value <PR URL>`. The review worker only reviews and merges a current, green head commit.
- The user must act: submit material through `ask`; report status with `notify`. Neither replaces the other.
- Scope growth: name the paths and the reason in a `blocked` notification; edit only after authorization covering the change arrives and the `scope` change is on the board. Reuse authorization you already have instead of asking again.

A local `nawaban notify` is a record on the board; outside messages or notifications still need their own authorization. Before stopping or handing off, record the real result and any remaining blocker; going idle is not a handoff.

## Reports and replies when a worker stops

Each time a worker started by `dispatch` stops, its Stop hook records the last message of its turn on the task and has the worker send it, with SendMessage, to the session that dispatched it. SendMessage is Claude Code's own cross-session messaging: it wakes the director even when that session is idle, and neither session ID changes. Nobody needs to watch the worker's pane or run a listener. As a worker, when the hook asks, send exactly the text it gives to the name it gives, then stop; when the send fails, do not retry and do not send it to anyone else, because the report is already on the board. Each message carries at most 1500 characters; longer text is truncated with a note, and the full text is in the task's notifications (`notifications --task <ID>`).

Stopping counts as delivery. When the worker sent no `blocked` notification, raised no open `ask` on its task during that turn, and has none of its own background sub-agents or background commands still running, the message starts with `[待 review]`: the worker is treated as having handed in its work for review, whether or not it reported `done`. Handing in is not finishing: the session stays until its PR is merged or the task is cancelled, so it can fix what the review finds.

When the director receives a report:

- `[待 review]`: dispatch a review worker now, or ask the existing one to review the new head commit, as in the director skill's Review and merging section; do not review it yourself. Review is not completion: the task still reaches done only with a `merge_sha`.
- Progress or completion only: no reply needed. Whether the task is done is still decided by its status and its `done` notification.
- The worker left a question the director can settle (implementation choice, a trade-off inside scope, which step comes first, whether to wait for a check): reply with SendMessage, `to` set to the worker's session name: the task ID in lower case, also recorded as `name` in the task's event that starts with `dispatch`. The worker wakes up and continues, and the reply is recorded on the task as a `reply` notification without a separate command. `notify --kind reply` only records; it does not reach the worker.
- A product-semantics fork, an external commitment, or a production release: the director does not answer these. It hands the material to the user through `ask`, then tells the worker the question went to the user and to do the work that does not depend on it.

On the worker side: to wait for an answer, first send a `blocked` notification (or raise an `ask` for the user), then put whatever the director must decide in the last message before stopping, with your recommendation, and stop instead of waiting in the pane. Stopping without either means you delivered. The director's reply appears directly in the worker's session.

Reports are sent only for workers whose dispatch record names a director session, and only while that session is running; otherwise the worker is told so and the report stays unread in the task's notifications. A session the user opened sends nothing when it stops. Any session can reply: SendMessage reaches the worker by name, and the reply is recorded whoever sends it. A worker's own SendMessage to its director is recorded as a `stage` notification. A worker whose session has stopped cannot receive anything; the sender is told, the message stays on the task as undelivered, and resuming the worker with `claude --bg --resume` is not the fix, because it can start a copy under a new session ID. After `dismiss`, nothing is sent or recorded. If the director session changes (the window was reopened), it no longer receives the old workers' reports; read the task's notifications instead.

Messages arrive whatever permission mode each side runs in: a director in `default` mode and workers in `auto` exchange messages in both directions without a prompt (Claude Code 2.1.302, [validation](../../../docs/sendmessage-validation.md)). Both sides need a Claude Code version that has SendMessage.

## Review worker

A review worker is dispatched on its own task (`<ID>-REVIEW`) to review another task's PR. It reads and records; it never changes the code under review.

1. Check out the PR's head commit in this worktree and read the diff against its base; run things there when a finding needs evidence. Judge against the reviewed task's `success`, `constraints`, and `touches`.
2. Write each finding with `summary`, `severity` (`critical`, `major`, `minor`, `nit`), `evidence` (file:line and how to make it fail), and `preexisting` (true when the problem was there before this PR), then record them on the reviewed task: `review <ID> --commit <full head SHA> --findings <JSON file>`. The command decides pass or fail: `major` or worse that is not preexisting blocks, a `critical` without evidence counts as `major`. It refuses a session that worked on the task or registered its PR.
3. Failed: `notify <ID>-REVIEW --kind blocked` with the blocking findings and stop. When the director asks you to review a new head commit, start again from step 1 on that commit.
4. Passed: in a repository where merging triggers a production deploy, raise `ask --kind authorize` and merge only after the answer lands. Otherwise wait for green CI and run `gh pr merge <PR> -R <OWNER/REPO> --match-head-commit <reviewed SHA>` as one standalone command ([PR and review](review-pr.md)). When the gate refuses because `main` moved, notify the director so the implementing worker brings the branch up to date; review the new head commit when asked.
5. After the merge: register the merge SHA on both tasks (`ref <ID> --kind merge_sha --value <merge SHA>`, and the same for `<ID>-REVIEW`; a task without one cannot move to done), move both to done, and send a `done` notification with the merge SHA.
