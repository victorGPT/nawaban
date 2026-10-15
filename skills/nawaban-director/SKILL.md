---
name: nawaban-director
description: Use when this window acts as the director, splitting one request into tasks and dispatching them to separate worker sessions, reading and replying to workers' notifications, rolling up acceptance, and closing out the batch. When this window edits files itself, use nawaban instead.
---

# nawaban director

The director turns one request into several tasks, dispatches them to separate worker sessions, and brings the results back on the evidence recorded on the board.

The director writes the board, not the tree: creating tasks, linking dependencies, recording decisions, answering questions, and marking notifications read are the director's work; workers change project files. When this window needs to change files itself, switch to [nawaban](../nawaban/SKILL.md) and claim a task like any ordinary one.

Commands take the form `nawaban --db <absolute path of target db> <verb>`; look up flags with `--help`. Entry point, target database, and session identity are in [Runtime and identity](../nawaban/references/runtime.md).

## Six rules

1. **The director changes no project files.** It writes no code and does not choose the worker's implementation method. Anything that needs changing becomes a new task or goes onto an existing one.
2. **A task says what to do and how to tell it is done, never how to do it.** When an acceptance criterion cannot be written as an observable result, do not dispatch; go back and clarify the requirement.
3. **One task, one session, started by the dispatch command.** Sub-agents are only for searching and review, never workers.
4. **The task is the source of truth.** Notifications and the messages workers send back are the worker's own account; check the task's status, refs, and events before concluding.
5. **Acceptance counts only evidence on the board.** Verification not on the board did not happen. Decisions that need a human go through `ask` and wait for the `answer` to land on the board.
6. **Escalate only three things: a product-semantics fork, an external commitment, a production release.** Settle everything else yourself. Before closing out, reconcile against the board, not memory.

The test for rule 6: if the answer changes what the user sees, what is said to the outside, or the live system, hand it to the user; otherwise decide and record it on the task.

## Splitting and creating tasks

Split only for separate delivery, different owners, or an ordering constraint. Field conventions are in [Creating tasks and scoping](../nawaban/references/grill-protocol.md).

- Create a subtask with `create <ID> --title "<title>" --context "- <background>" --split-from <parent> --success '<JSON array>' --touch <path>`; batch dispatch finds subtasks through this split relation.
- Express order with `link <blocked task> <prerequisite task> --kind depends_on`. Splitting from the same parent does not make tasks depend on each other.
- When two tasks' `touches` overlap, either order them or write on each task which part it changes.
- When subtasks must ship together (one PR into `main`), use an integration branch: create `int/<parent>` from `main`, push it, and give each subtask `--constraints '["PR target branch: int/<parent>"]'` when creating it. Per the dispatch brief, the worker merges the latest `main` and the target branch into its own branch before opening the PR: the merge gate requires the PR's HEAD to contain the latest `main`, and `gh pr update-branch` only syncs the target branch, so it cannot bring `main` in. Subtask PRs into the integration branch and the integration branch into `main` are merged by the director, as in the Merging section below.

## Dispatching and dismissing

Run these in the target repository:

```bash
nawaban --db <target db> dispatch <ID>                      # one task
nawaban --db <target db> dispatch --parent <parent> --dry-run  # which would be dispatched, which not, and why
nawaban --db <target db> dispatch --parent <parent>            # dispatch open subtasks whose prerequisites are all done
nawaban --db <target db> dismiss <ID>                       # after the task is done or handed off
```

- `dispatch` starts a separate session named after the task ID, gives it its own worktree, sends the task as its first message, and records the session ID on the task. The worker claims the task itself once it arrives.
- Dispatch starts Claude Code sessions, so the machine running it needs the `claude` command. Without it, `dispatch` reports that the session did not start, and neither this section nor the replying in the next one works; a person then starts each task by hand.
- Dispatch also works without a terminal multiplexer: the session then runs in the background, visible through `claude agents`.
- A task that is already claimed, not open, has unfinished prerequisites, or has a same-named session still running is not dispatched; the command says why.
- `dismiss` stops the session and removes the worktree. It leaves a worktree with uncommitted or unpushed changes in place and says why; first have the worker commit and push, or confirm yourself that the changes can be discarded.
- After a subtask reports done and passes acceptance, run `dispatch --parent <parent>` again: subtasks whose prerequisite just finished can only be dispatched now.
- Dismiss a task in the same turn it passes acceptance. Finished work with the session still open and the worktree still in place is not wrapped up.

Never use the Agent tool to start a named sub-agent as a worker: it has no session ID of its own, the board cannot record it, and all of its output flows back into the director's window.

## Notifications and replies

Workers report stages, blockers, and completion through notifications:

```bash
nawaban --db <target db> notifications --unread              # all unread
nawaban --db <target db> notifications --unread --task <ID>  # one task; the full task ID, prefixes are not supported
nawaban --db <target db> notify-read <notification ID>...     # mark read after handling
```

Each time a worker stops, the last message of its turn may also be sent straight to the director's window. When a Herdr worker's pane, tab, or workspace is closed before its task is finished or handed off, a message of the same kind says so and the task gets an event starting with `pane closed`; nobody needs to start a listener for this. Handle notifications and these messages the same way:

1. Check the task first: `context <ID>` shows its status, current state, events, and refs. Messages sent back have a length limit; when one is truncated, the task wins.
2. When the worker left a question the director can settle, settle it in the same turn: `notify <ID> --kind reply --msg "<decision and reason>"`. The reply lands on the task and wakes the worker to continue; delivery rules are in the [Worker protocol](../nawaban/references/director-worker.md). When the answer changes an acceptance criterion, also record it with `decide --set-success`. The user's answers also reach the worker as the director's replies; never send the user to answer in the worker's window.
   A reply is accepted only from the session that dispatched the worker. When this window is not that session (the window was reopened), send the message directly according to the backend recorded in the task's event that starts with `dispatch`:
   - `"backend": "claude-bg"`: in its worktree directory, first `claude stop <first 8 characters of the session ID>`, then `claude --bg --resume <session ID> "<reply>"`. Stop before resuming: resuming a session that is only idle, not stopped, starts a copy, and the original worker never receives the reply.
   - `"backend": "herdr"`: `herdr agent prompt <lowercase task ID> "<reply>"`.
3. One of the three escalation kinds: do not answer it yourself; pass it to the user (see `ask` in the next section).
4. Judge whether a worker is done from the task's status and its notifications, not from whether its session looks idle.
5. Scope growth: the worker names the paths and the reason; once the director agrees, record it with `scope <ID> --add <path> --reason "<reason>"`, and only then may the worker change them.
6. Never mark a worker as blocked in Herdr (`herdr pane report-agent --state blocked`), and tell workers not to either; a blocker goes on the board as `notify --kind blocked`. Herdr treats a blocked pane as sitting at an approval dialog and rejects every `herdr agent prompt` to it with `agent_blocked` before sending anything. Dispatch hands the worker its brief that way, and the `"backend": "herdr"` reply in step 2 goes the same way, so the worker would never get either.

## Acceptance and close-out

Go through the task's `success` item by item; every item needs matching evidence on the board: test results, a PR, a run record. Separate what really ran from what was only tested against doubles; write unverified items as unverified and send them back to the worker; the director does not run them in its place.

### Merging

The user has authorized this: once a task passes acceptance and review finds nothing blocking, the director merges its PR in the same turn without asking the user again.

1. Review: have a sub-agent review the PR diff read-only at the PR's head commit, or use the review the project requires. The reviewer returns only findings, each with `summary`, `severity` (`critical`, `major`, `minor`, `nit`), `evidence` (file:line and how to make it fail), and `preexisting` (true when the problem was there before this PR). Record them with `review <ID> --commit <full head SHA> --findings <JSON file>`; the command decides pass or fail, not you. A finding blocks when it is `major` or worse and not preexisting; a `critical` without evidence counts as `major`; preexisting problems are recorded only. When it fails, send the blocking findings back to the worker and review again after the fix. After 3 failed reviews in a row the command puts a `decide` ask in the user's inbox; wait for its answer instead of starting a fourth round.
2. Merge: wait for all-green CI with `gh pr checks <PR> --watch`. When the branch is behind `main`, a PR targeting `main` gets `gh pr update-branch <PR>`; for a PR targeting an integration branch, reply asking the worker to merge the latest `main` and push. Either way, wait for another CI round. Any new commit, including the merge commit `update-branch` creates, needs a new review, so bring the branch up to date before step 1 when you can. Then run `gh pr merge <PR> -R <OWNER/REPO> --match-head-commit <reviewed SHA>` as one standalone command; details are in [PR and review](../nawaban/references/review-pr.md). When the repository belongs to a gh account other than the active one, put `GH_TOKEN=$(gh auth token --user <account>)` in front of that command, for the nawaban repository `--user victorGPT`; do not switch the global gh account.
3. Record: reply to the worker with the merge SHA so it registers `merge_sha` and transitions to done as in [Delivery and wrap-up](../nawaban/references/cards.md), then `dismiss`.

In a repository where merging triggers a production deploy, merging is a production release: use `ask --kind authorize` instead. Before merging an integration branch into `main`, finish the whole-batch review in close-out item 4.

When the user must decide:

```bash
nawaban --db <target db> ask --kind decide --question "<one question>" --evidence "<material>" --task <ID> --option "<option>|<consequence>" --option "<option>|<consequence>"
nawaban --db <target db> ask --kind authorize --question "<one question>" --evidence "<material>" --task <ID> --blast "<who is affected>|<what changes>|<how to roll back>"
nawaban --db <target db> ask --kind accept --question "<one question>" --evidence "<actual result read>" --task <ID>
nawaban --db <target db> inbox                               # asks still unanswered
nawaban --db <target db> answer <ask ID> --verdict "<the user's own words>"
```

`decide` needs at least two `--option` flags and `authorize` needs a three-part `--blast`; the command refuses otherwise. The material for `accept` must be an actual result you read; "PR merged" or "CI green" alone is refused. When the user answers in the conversation, the director writes it back verbatim with `answer`. `answer` only records the decision and executes nothing; when it says `fanout <ask ID> --ok|--failed` must also run, run it only after the authorized action has actually finished.

Before announcing close-out, check all four:

1. `dispatch --parent <parent> --dry-run` lists every subtask's current status, and no task is still in progress or unowned.
2. `notifications --unread --task <subtask ID>` is empty for every subtask. Unread notifications on other tasks in the database are not this batch's to handle; do not mark them read for others.
3. `inbox` has no unanswered ask for this batch's tasks.
4. This batch's changes were reviewed together: a sub-agent reviewed the integration branch's whole diff against `main` (without an integration branch, the batch's PRs), looking only for cross-task problems. Every problem found was made a task or written onto the matching subtask, and has been handled.

If any item fails, do not announce; report to the user what remains. When all pass, make sure `dismiss` has run for every dispatched task, then report to the user: one line per task with its status, an evidence pointer, and what was not verified.
