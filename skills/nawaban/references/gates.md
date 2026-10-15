# Status and hook gates

After a rejection, read the reason the tool gave, then check the target board, the owner, the status, and the missing fact. Fix the actual precondition and keep the project's authorization boundary.

| Gate | Fires when | Legal handling |
|---|---|---|
| maintree hook | A project file is changed in the shared main checkout; a relative path in a shell write is resolved from the session directory, not from a `cd` in the command | Work in the task's worktree and give shell writes an absolute path inside it; a hook exemption does not change authorization |
| merge hook | `gh pr merge` is chained with another command, piped or redirected, or carries variables or an environment-variable prefix other than `GH_TOKEN=$(gh auth token --user <account>)`; the PR's checks are empty or not all green; the PR branch is behind `main`; a GitHub query fails (the message names the gh account used) | Run `gh pr merge <PR> -R <OWNER/REPO>` on its own, with that account prefix when the active gh account cannot merge in the repository; when behind, run `gh pr update-branch <PR>` first and merge after the new CI round is all green |
| branch hook | A task branch is created or checked out in the main checkout | Create a separate worktree and keep the main checkout on `main`; repair a wrong branch with the project's recovery procedure |
| claim dependency | A `depends_on` prerequisite is not `done` or `cancelled` | Check the prerequisite and finish it first; use an override with a reason only when project authorization covers it |
| claim line stop | This project's `main` CI is red, and no open `regresses` fix task exists since it went red | `nawaban blame <failing file>` finds the done task that broke it; create a fix task and `link <fix task> <broken task> --kind regresses --note "<which merge>"`. Use an override with a reason only for red unrelated to a regression (infrastructure, flakiness) |
| start | The task is not `claimed`, or the owner does not match | Check whether it already started, was returned, or is held by another owner, and continue from the real state |
| staging-verified / done | Evidence or a valid decision is missing, or the transition is not legal | Add real evidence as in [Delivery and wrap-up](cards.md); confirm flags in the CLI help |

The CLI enforces the database-level checks; edit and branch protection works only when the caller has installed the matching hooks. A `touches` conflict is a WARN. The old grill/design/flag fields and the Markdown done-gate are not part of the current database protection.

Sources: `$NAWABAN_HOME/nawaban/db.py`, `nawaban/guard.py`, and `hooks/foreman_branch_gate.py`; regressions live under the project's `tests/upstream/` in `test_workos_db.py`, `test_workos_guard.py`, and `test_branch_gate.py`. Check only the gate you actually hit; an ordinary change does not need a tour of the implementation.
