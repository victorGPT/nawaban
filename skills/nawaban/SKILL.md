---
name: nawaban
description: Use before changing files, committing, or creating a branch in a repository with a nawaban board, even for a one-character edit. Says which worktree to edit in and how to claim, advance, resume, and hand off a task. Not needed for only reading files or answering questions.
---

# nawaban task work

Keep the task, its worktree, and the delivery evidence in agreement while you finish what the user authorized. nawaban owns tasks, worktrees, and status; the target project owns implementation method and delivery scope.

## Start or resume

Read the target task's `success`, `constraints`, `touches`, owner, status, `now`, and refs; read a linked ADR when the work needs it. The current user request and the project's tracker win; earlier decisions and authorization for the same scope stay valid.

- **Query or review**: read the state and evidence you need. "Who is working on what" is answered without claiming, creating a task, or editing.
- **Implement**: confirm a checkable completion condition, then claim and move into the task's worktree. Ask only about a missing decision that changes scope, behaviour, or risk; settle every other choice yourself.
- **Resume**: check the owner, the latest handoff, and the existing worktree first, and reuse that worktree; skip steps already done. A task returned to `open` needs claim → start again; another owner's task needs coordination first.

On first use, or across projects, read [Runtime and identity](references/runtime.md) to confirm the CLI, the target database, and the session identity. Resolve relative links from this skill's real path (an installed entry may be a symlink).

## Claim and worktree

Every write carries the `NAWABAN_OWNER` and `CLAUDE_CODE_SESSION_ID` the session provides. Use one target database throughout, and replace each placeholder below with a verified value.

```bash
nawaban --db <absolute path of target db> claim <ID>
nawaban --db <absolute path of target db> start <ID> --now "<the work in progress now>"
git worktree add <worktree path> -b task/<ID>
```

Create a worktree only when the task has none. The shared main checkout stays on `main`; edit project files in the task's worktree. When a shell command writes a file (redirect, `tee`, `sed -i`), give it an absolute path inside the worktree: the write gate does not follow a `cd` in the command. Authorized files outside the repository are handled by their real paths in `touches`. When scope grows, confirm the authorization and record it with `scope` before editing. The overlap WARN from `claim` is a coordination hint, not a scope contract.

## Advance and finish

When a test fails in your worktree and your change did not cause it, do not skip it as "already broken": run `nawaban blame <failing file>` to find the done task that broke it, create a fix task, `link --kind regresses`, then return to your task.

Keep doing the authorized implementation, its checks, and their fixes until `success` is met or a specific blocker needs outside input. Pick verification from the behaviour affected; after checks pass, re-verify only for a new change, a failure, or an open risk. When the work has a runtime effect, check the target runtime environment; record local tests, deploy results, and human acceptance separately.

The user and the project set the delivery boundary: local files, commit, PR, merge, and deploy each need authorization of matching scope. This skill does not by itself require a PR, a deploy, or another task. For unmerged work, record the commit or artifact and the real handoff state; never invent a `merge_sha` to reach done.

Before stopping, sync status, `now`, refs, and handoff as in [Delivery and wrap-up](references/cards.md); with work left, leave the evidence, the remaining work, and one clear next step. To review only this session's claims, use [nawaban-wrapup](../nawaban-wrapup/SKILL.md).

## Read when

| Situation | Reference |
|---|---|
| No task yet, a goal to split, or a decision to record | [Creating tasks and scoping](references/grill-protocol.md) |
| Overlap warning from `claim`, or a dependency, edit, or archive rejected | [Overlap coordination](references/locks.md), [Status and hook gates](references/gates.md); read only the relevant rows |
| This session is a worker dispatched by a director, or explicitly follows the worker protocol | [Worker protocol](references/director-worker.md) |
| A PR is in scope or the project requires independent review | [PR and review](references/review-pr.md); for adding commits to a PR or resolving a conflict, also [Git collaboration](references/git-shared-tree.md) |
| An extra capability is needed, or an old Markdown task is being read | [Capability catalogue](references/skill-shelf.md) or [Historical tasks](references/md-cards.md), whichever applies |

## External capabilities

Load these only when the condition holds and the capability is enabled; a missing optional capability does not block ordinary work. The optional skill_shelf inventory tool also reads this table.

| Condition | Optional capability |
|---|---|
| An important requirement fork is unresolved | `grilling` or the current requirement-clarifying capability |
| The project requires a specific implementation or review method | `tdd`, `code-review`, or an enabled equivalent, as the project chooses |
