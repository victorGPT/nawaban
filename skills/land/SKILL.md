---
name: land
description: "For the orchestrator. Finish a ticket whose worker reports 完成. Use when a worker's report arrives, or a ticket shows a line that starts merge: 已合未收完 or merge: 拒合."
---

Land the work, then free the worker.

1. On the board the worker lands its own ticket with `nawaban merge <PR>`: it merges, updates the plugin, closes the ticket, and keeps or retires the worker. On a ticket dispatched with `--check` (only what CI cannot cover: an end-to-end probe, a read-only check against the real environment; a code ticket puts no vitest there), merge runs those commands with the board's `tasks run` and merges only when all exit 0. A failing one leaves the ticket `failed`, with the output tail in a `merge: 拒合 — 验收检查没过` line, and the worker fixes it and reruns merge. You act only on a `merge:` line on the ticket: fix what it names (a schema pull is step 4, with no ask), then have the worker rerun the same command.
2. Elsewhere, read before you merge: every check passed on the head commit; a comment `<reviewer> review：无挡…` names that commit, unless the pull request changes only `.md` files; the ticket has its KR registration where the repository has `docs/agents/okr.toml`.
3. Merge with `GH_TOKEN=$(gh auth token --user <the repository's GitHub account>) gh pr merge <PR> --squash --match-head-commit <sha>`, record the pull request as a `link` event, close the ticket as done.
4. When the merged repository is nawaban, update this machine: `git -C ~/.nawaban/plugin pull --ff-only && sh ~/.nawaban/plugin/herdr/install-mod.sh`. For a change to the schema or to data, run `nawaban backup` first.
5. After a ticket that registered a KR closes, whoever closed it, run `nawaban okr` once. A hard stop it prints goes to the owner through the **ask** skill.
6. Elsewhere, route the worker's next ticket with the **dispatch-route** skill. Closing the ticket retires a worker left with none: `close --done` or `--cancelled` does it at once, and the orchestrator's Stop hook catches an issue closed on GitHub (`Closes #N`, `scripts/merge.sh`) within a minute. It removes the worktree, keeps one with uncommitted changes, and never touches a terminal no dispatch named, the orchestrator, or a worker still working.

Never merge on a report alone: read the checks and the review line yourself. No padding.
