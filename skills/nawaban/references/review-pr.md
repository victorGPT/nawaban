# PR and review

Use this only when a PR is part of the delivery or the project requires review. Follow the project's rules for required review, CI, and merge conditions; a security-sensitive or critical-data change resolves confirmed defects before delivery. An ordinary text update does not by itself call for a prototype, a second opinion, or a cross-model pipeline.

## Preparing a review

The review package holds the user's request, the task's `success`, `constraints`, and `touches`, the files actually changed, and the version under review. The review recorded with `nawaban review` must come from another session: dispatch a review worker on its own task (`<ID>-REVIEW`), which follows the [Review worker](director-worker.md#review-worker) protocol. This holds when a single session did the work alone too. The command refuses a session that worked on the task or registered its PR. The reviewer's result names the version, the findings, and the limits of its verification.

Judge findings by reachable call paths, the source, and relevant verification; severity says nothing about whether a finding is true. Fix confirmed problems inside this scope; record out-of-scope problems separately and ask for a decision only when they need new scope or a real trade-off. After a change, recheck only the affected parts and the required gates.

When a review the project requires is missing or failed, name the gap; never report it as reviewed. Ask for an extra second opinion only on an unresolved doubt that affects delivery, not on a fixed schedule.

## Committing and opening a PR

When authorization covers commit, push, and PR, use the project's Git and GitHub entry points in the task's worktree. Check the actual diff item by item and stage only this delivery's files; after committing, push the branch to the verified remote, then open the PR with `gh pr create` or the project's tool. The PR description states the concrete behaviour change, the verification results, and what is unfinished.

When merging is in scope, a session with the hooks installed checks these before merging: the PR branch contains the latest `main` (new commits on `main` do not count when they all carry a `[skip ci]`-style marker, or change none of the PR's files and do not add a migration alongside the PR's; `main` CI is then the backstop), checks are non-empty and all green, and the merge command can be checked in full. When an unfinished task on the board has the PR's full URL as a `pr` ref, the gate also requires that task's latest `review` to pass on the PR's head commit and the merge to be locked to that commit. Register the PR with `ref <ID> --kind pr --value <PR URL>`; a bare number is completed from the checkout's GitHub remote or refused, and bare numbers already on older tasks do not count. Wait for CI with `gh pr checks <PR> --watch`; when the branch is behind, run `gh pr update-branch <PR>` and wait for the new CI round. Then run `gh pr merge <PR> -R <OWNER/REPO> --match-head-commit <reviewed SHA>` as one standalone command, with no `cd`, `&&`, pipe, `2>&1`, or variables. The one allowed prefix selects the gh account for a repository the active account cannot merge in: `GH_TOKEN=$(gh auth token --user <account>) gh pr merge …`; the gate runs its queries as that same account. Use it instead of `gh auth switch`, which changes the account for every other repository too.

When the project ships its own helper, first check what it does to commits, history, and outside systems; nawaban ships no PR helper and depends on no personally installed script. For adding commits to a PR or resolving a conflict, read [Git collaboration](git-shared-tree.md). The current reviewed version is what counts; an old verdict does not cover later changes.
