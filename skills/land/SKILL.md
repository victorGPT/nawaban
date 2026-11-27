---
name: land
description: "For the orchestrator. Finish a ticket whose worker reports 完成. Use when a worker's report arrives, or a ticket shows a line that starts merge: 已合未收完 or merge: 拒合."
---

**Land the work, then free the worker. Never merge on a report alone.**

1. **On the board, the worker lands its own ticket.** `nawaban merge <PR>` merges, runs the ticket's `--check` commands, updates the plugin, and closes the ticket. Act only on a `merge:` line on the ticket: fix what it names, then have the worker rerun the same command. A schema pull it names goes straight to step 3, with no ask.
2. **Elsewhere, merge the way the repository says.** Read the merge section of its `docs/agents/review.md` (for example `scripts/merge.sh <PR>`). Before you merge, read two things yourself: every check passed on the head commit, and a comment `<reviewer> review：无挡…` names that commit. A pull request that changes only `.md` files needs no review line. With no merge section, run `GH_TOKEN=$(gh auth token --user <account>) gh pr merge <PR> --squash --match-head-commit <sha>`. After the merge, record the pull request as a `link` event and close the ticket as done.
3. **When the merged repository is nawaban, update this machine.** Run `nawaban backup` first for a schema or data change, then `git -C ~/.nawaban/plugin pull --ff-only && sh ~/.nawaban/plugin/herdr/install-mod.sh`.
4. **When a ticket that registered a KR closes, run `nawaban okr` once.** Send a hard stop it prints to the owner through the **ask** skill.
5. **Elsewhere, route the worker's next ticket** with the **dispatch-route** skill. Retire a worker left with nothing as the [nawaban skill](../nawaban/SKILL.md#dispatch-and-merge) says.
