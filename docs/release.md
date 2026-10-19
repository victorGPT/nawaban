# Release and update

Checked on 2026-10-16 with Claude Code 2.1.301.

## How a GitHub install gets new code

Claude Code updates an installed plugin only when `version` in `.claude-plugin/plugin.json` changes. New commits under the same version are not delivered.

Tested in an isolated `CLAUDE_CONFIG_DIR`, with the marketplace added as `victorGPT/nawaban#<branch>` (the `#ref` form pins a branch) and a commit pushed to that branch between steps:

| Step | Result |
|---|---|
| Install at `8a32a62`, version `0.1.0` | Cache `cache/nawaban/nawaban/0.1.0`, `gitCommitSha` `8a32a62` |
| Push `e868a25` (adds `hooks/UPDATE_PROBE.txt`, version still `0.1.0`), run `claude plugin update nawaban@nawaban` | Marketplace clone moved to `e868a25`; plugin reported "already at the latest version (0.1.0)"; cache unchanged, no probe file |
| `claude plugin marketplace update nawaban`, then `plugin update` again | Same: "already at the latest version", cache still `8a32a62` |
| `claude plugin uninstall` then `install`, same version | Cache rebuilt at `e868a25`, probe file present |
| Push `4a7d104` (version `0.1.1`), run `plugin update` only | "updated from 0.1.0 to 0.1.1 … Restart to apply changes"; new cache `0.1.1` at `4a7d104` |

So a release for other users is:

1. In the PR that should reach them, raise `version` to the same value in both `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (patch for fixes, minor for new behaviour).
2. After it merges, users run `claude plugin marketplace update nawaban && claude plugin update nawaban@nawaban`, then start a new session.

A user who needs code merged without a version bump can run `claude plugin uninstall nawaban@nawaban && claude plugin install nawaban@nawaban`.

## Maintainer machine: run from a separate checkout

A `directory` marketplace loads the skill straight from that directory, and the skill points sessions at the CLI there. If it points at the development checkout, a branch switch, an uncommitted edit or a half-finished pull there changes what every open session runs. Point the marketplace at a clone that only follows `main` instead:

```sh
git clone https://github.com/victorGPT/nawaban.git ~/.nawaban/plugin
claude plugin marketplace add ~/.nawaban/plugin   # re-points the existing "nawaban" marketplace in place
```

`marketplace add` with a new path for an existing marketplace name keeps the installed plugin and prints "now points at …"; no remove or reinstall is needed. Sessions started before the switch keep the old path until they are restarted.

| Action | Command |
|---|---|
| Publish after a merge | `git -C ~/.nawaban/plugin pull --ff-only` |
| Roll back the last publish | `git -C ~/.nawaban/plugin reset --hard ORIG_HEAD` |
| Go to a specific commit | `git -C ~/.nawaban/plugin reset --hard <sha>` |
| See what is live | `git -C ~/.nawaban/plugin log -1 --oneline` |

The CLI is read on every call, so a publish or rollback reaches open sessions at their next command. Running `ORIG_HEAD` twice undoes the rollback; the next `pull --ff-only` moves forward to `main` again. Publish and rollback were rehearsed on a copy of the clone: `reset --hard HEAD~2` → `pull --ff-only` reached `8a32a62` → `reset --hard ORIG_HEAD` returned to `6aff36e`.

The skill loads from the same directory. The clone has no built `nawaban/webui/dist`, so either keep the board running from where it was built or build it there once with `npm --prefix ~/.nawaban/plugin/nawaban/webui ci && npm --prefix ~/.nawaban/plugin/nawaban/webui run build`. The `nawaban` CLI used in shells is whatever path you call; calling the development checkout's `cli.py` runs development code against the same database.

### Checked after switching (2026-10-16, when the plugin still had hooks)

The marketplace was switched to `/Users/victor/.nawaban/plugin` (at `8a32a62`). Then a new `claude -p` session was started from a development worktree on a non-`main` branch. That worktree had an uncommitted edit making `hooks/foreman_session_start.py` print `DEV-MARKER`; running that file directly printed it. While the session ran, `ps -axEww` was sampled every 0.1 s:

| Check | Result |
|---|---|
| SessionStart hook process | `/Users/victor/.nawaban/plugin/hooks/foreman_session_start.py`, `CLAUDE_PLUGIN_ROOT=/Users/victor/.nawaban/plugin` |
| Stop hook processes | `/Users/victor/.nawaban/plugin/nawaban/compile_gate_headless.sh`, `/Users/victor/.nawaban/plugin/hooks/foreman_maintree_watch.sh` |
| Session banner | `board-up.sh` hint names `/Users/victor/.nawaban/plugin/nawaban/board-up.sh` |
| `DEV-MARKER` in the session's hook output | 0 occurrences |
| `worker_report.py` of sessions started before the switch | Still `CLAUDE_PLUGIN_ROOT=/Users/victor/nawaban`, until restarted |

The main checkout itself was not switched or edited in this check.

### Undoing the switch

Before switching, copy the files `marketplace add` changes:

```sh
B=~/.nawaban/backups/claude-plugins-$(date +%Y%m%dT%H%M%S); mkdir -p "$B"
cp ~/.claude/settings.json ~/.claude/plugins/known_marketplaces.json ~/.claude/plugins/installed_plugins.json "$B"/
```

To go back, run `claude plugin marketplace add <previous path>` (the development checkout), or copy the three files back from the backup and restart the sessions.
