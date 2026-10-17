# Git collaboration and conflicts

One pane, one worktree: branches and indexes stay separate. Two places still need care.

## Adding commits to an existing PR

First check the current worktree branch against the remote PR head, and protect uncommitted changes. When another agent or a project helper has updated the PR head, sync by the project's collaboration rules before adding ordinary commits; get authorization before rewriting history. Before pushing, check the full diff against the PR base so it contains only this task's delivery.

Building a commit from an old worktree's full tree with `commit-tree -p <PR head>` overwrites what the PR head added; when syncing, keep the committed changes from both sides.

## A real conflict: recover intent

The second person to merge resolves the conflict: read both sides' commits, PRs, and tasks to recover each side's intent, keep both where possible, and when they cannot coexist choose by this merge's goal and record the trade-off in the PR body. Run the typecheck and the relevant tests before committing. Add no behaviour that neither side had.
