# Installation

The [README](../README.md#install-as-a-plugin) has the short path. This page covers the GitHub install, Codex, running without a plugin, and session identity.

## Plugin install

The same checkout is a Claude Code plugin and a Codex plugin. It ships one skill, `nawaban`, and registers no hooks, so there is nothing to trust or approve beyond installing it.

- **Claude Code:** `claude plugin marketplace add /path/to/nawaban`, then `claude plugin install nawaban@nawaban`. For a one-off session, `claude --plugin-dir /path/to/nawaban` also works. With this directory marketplace, Claude Code reads the plugin from the checkout; start a new session after pulling. If you also develop nawaban, point the marketplace at a separate clone that only follows `main`, so branch switches and uncommitted edits stay out of your sessions ([release and update](release.md)).
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

## Run from a checkout

Set `NAWABAN_HOME` to this checkout and define the CLI in your shell (no package installation required):

```sh
export NAWABAN_HOME="$(pwd)"
nawaban() { python3 "$NAWABAN_HOME/nawaban/tracker.py" "$@"; }
```

Run `nawaban init` in the project to create `.nawaban/nawaban.db`, then `nawaban list`. The CLI picks the board from an explicit `--db`, then `NAWABAN_DB`, then `.nawaban/nawaban.db` in the repository's main checkout (so linked worktrees share it), then the nearest `.nawaban/` above the current directory. Several projects can share one board: pass the same absolute `--db` everywhere; a new task's project defaults to its parent's, then to the repository holding the board. `nawaban backup` copies the board into `backups/` beside it.

Build the board UI once per checkout with `npm ci && npm run build` in `nawaban/webui` (the build output is not committed; without it the board serves the built-in fallback page).

Launch the board with `bash "$NAWABAN_HOME/nawaban/board-up.sh"`. `NAWABAN_BOARD_PORT` and `NAWABAN_BOARD_HOST` select the listener; `NAWABAN_DB` selects its board.

## Session identity

Commands that write as someone (`claim`, `close`, `event`) take the identity from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets in every session, then from `NAWABAN_OWNER`. Codex sets no session variable, so set `NAWABAN_OWNER` to a stable name in the environment Codex runs commands in; without either variable those commands refuse and say so.
