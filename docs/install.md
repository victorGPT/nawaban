# Installation and hooks

The [README](../README.md#install-as-a-plugin) has the short path. This page covers Codex, hook trust, what each gate inspects, running without a plugin, and session identity.

## Plugin install

The same checkout is a Claude Code plugin and a Codex plugin; both read `hooks/hooks.json`.

- **Claude Code:** `claude plugin marketplace add /path/to/nawaban`, then `claude plugin install nawaban@nawaban`. For a one-off session, `claude --plugin-dir /path/to/nawaban` also works. With this directory marketplace, Claude Code loads the hooks straight from the checkout, so after pulling, each hook runs the new code the next time it fires; `claude plugin update` is not needed. Not verified: whether adding or removing an entry in `hooks/hooks.json` needs a new session ([validation](worker-backend-validation.md)). If you also develop nawaban, point the marketplace at a separate clone that only follows `main`, so branch switches and uncommitted edits stay out of your sessions' hooks ([release and update](release.md)).
- **From GitHub:** `claude plugin marketplace add victorGPT/nawaban`, then `claude plugin install nawaban@nawaban`. Claude Code updates the plugin only when `version` in `.claude-plugin/plugin.json` changes: run `claude plugin marketplace update nawaban && claude plugin update nawaban@nawaban`, then start a new session ([release and update](release.md)).
- **Codex:** add the checkout as a local marketplace in `~/.codex/config.toml`, then install it. Codex copies the plugin into its cache, so run `codex plugin add` again after pulling.

  ```toml
  [marketplaces.nawaban]
  source_type = "local"
  source = "/path/to/nawaban"

  [plugins."nawaban@nawaban"]
  enabled = true
  ```

  ```sh
  codex plugin add nawaban@nawaban
  ```

For a local checkout, clone `https://github.com/victorGPT/nawaban` and replace `/path/to/nawaban` with its absolute path. Private repositories require GitHub access.

Before the first non-interactive Codex run, start `codex` in your project and choose **Trust all and continue** at the hook review prompt. Installing the plugin alone does not grant hook trust. After exiting that session, a smoke check can use `codex exec --skip-git-repo-check "Report the nawaban SessionStart status from your context" </dev/null`. An initialized board with no active tasks shows the session identity and empty inbox; active tasks add the task status block.

The gates act only in a Git main checkout that has a nawaban board, for a session with an identity (`NAWABAN_OWNER`, a tmux window or a session id). Files under `.nawaban/` and `.foreman/`, and checkouts containing `.foreman/ALLOW_MAINTREE_EDIT`, stay writable. In `Bash`, the write gate catches common file writes (`>`/`>>` redirects, `tee`, `sed -i`) but not arbitrary scripts; the merge gate inspects `gh pr merge` commands, and the branch gate inspects `git checkout` / `git switch`.

| | Claude Code | Codex |
| --- | --- | --- |
| Session banner | Shown at session start | Shown at session start (as developer context) |
| Main-checkout write gate | Blocks `Edit` / `Write` / `MultiEdit` | Blocks `apply_patch`; target paths are read from the patch headers |
| Branch and merge gates | Block the `Bash` command | Block the `Bash` command |
| Session identity | `CLAUDE_CODE_SESSION_ID` | `session_id` from the hook input; Codex sets no session variable |
| Hook trust | Hooks run once the plugin is enabled | Codex asks you to trust the plugin hooks before they run |
| Headless compile gate (Stop) | Active only for `claude -p` | Inactive: the gate checks for Claude's headless entrypoint |
| Main-checkout dirt watch (Stop) | Prints a warning at turn end | Registered; its output in Codex is not verified |

## Run from a checkout

Set `NAWABAN_HOME` to this checkout and define the CLI in your shell (no package installation required):

```sh
export NAWABAN_HOME="$(pwd)"
nawaban() { python3 "$NAWABAN_HOME/nawaban/cli.py" "$@"; }
```

Run `nawaban init` in the project to create `.nawaban/nawaban.db`, then use `nawaban inbox`. An explicit `--db` takes priority over `NAWABAN_DB`; existing legacy configuration remains supported as described in [CHANGELOG.md](../CHANGELOG.md). Initialization uses the new default path unless an explicit database path or environment override is supplied.

Build the board UI once per checkout with `npm ci && npm run build` in `nawaban/webui` (the build output is not committed; without it the board serves the built-in fallback page). The Modules view includes the dependency network.

Launch the board with `bash "$NAWABAN_HOME/nawaban/board-up.sh"`. `NAWABAN_BOARD_PORT` and `NAWABAN_BOARD_HOST` select the listener; `NAWABAN_DB` selects its board. Linked Git worktrees resolve the board in the shared main checkout.

## Session identity and state

Session registry and reconciliation reports use `NAWABAN_STATE_DIR`, then `~/.local/state/nawaban`. When the new registry is absent, session lookup reads the previous `~/.claude/foreman/session-registry.json`; the next registration preserves its entries in the new file without modifying the old one.

Session-derived owners use `ac:<full session UUID>` so sessions sharing the first
eight characters remain distinct. `NAWABAN_OWNER` takes precedence. Existing
`ac:<8 hex characters>` cards are not rewritten: activity probes retain their prefix
alias (using the newest matching transcript), while new owners match exactly.
Continuing a legacy card with the new identity requires its existing, still-open
full session history; start, handoff, ownership warnings, and the session banner
use that same check. No schema migration is needed.
