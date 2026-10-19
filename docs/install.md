# Installation

The short path: paste this into Claude Code or Codex, in the project that should get a board.

```text
Install nawaban by following https://github.com/victorGPT/nawaban/blob/main/docs/install.md and create a board in this project.
```

The agent follows the next section. The sections after it are the same install by hand, and the details behind it.

## For the agent doing the install

Run these steps in order. Each one is safe to run again. Stop and tell the user if a step fails.

1. Check that `git` and `python3` exist and that `python3 --version` is 3.9 or newer. Node is not needed: the board UI is already built.
2. Put nawaban at `~/nawaban`. If that directory exists and is a nawaban checkout, run `git -C ~/nawaban pull --ff-only`; otherwise run `git clone https://github.com/victorGPT/nawaban ~/nawaban`.
3. Install the plugin.
   - Claude Code: `claude plugin marketplace add ~/nawaban`, then `claude plugin install nawaban@nawaban`.
   - Codex: add the marketplace and plugin entries shown under [Plugin install](#plugin-install) to `~/.codex/config.toml` with `source = "<absolute path of ~/nawaban>"`, then run `codex plugin add nawaban@nawaban`. Also set `NAWABAN_OWNER` to a stable name in the environment Codex runs commands in ([Session identity](#session-identity)).
4. In the user's project, create the board: `python3 ~/nawaban/nawaban/cli.py init`. It prints the board path, or says the board already exists.
5. Start the board: `bash ~/nawaban/nawaban/board-up.sh`, run from the project. It prints the address, `http://127.0.0.1:8813/` by default.
6. Tell the user three things: the board address, the board path from step 4, and that the `nawaban` skill loads in a new session, so they should start one.

Optional, for a person who wants to type commands: add `nawaban() { python3 ~/nawaban/nawaban/cli.py "$@"; }` to their shell profile, only if they ask.

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
nawaban() { python3 "$NAWABAN_HOME/nawaban/cli.py" "$@"; }
```

Run `nawaban init` in the project to create `.nawaban/nawaban.db`, then `nawaban list`. The CLI picks the board from an explicit `--db`, then `NAWABAN_DB`, then `.nawaban/nawaban.db` in the repository's main checkout (so linked worktrees share it), then the nearest `.nawaban/` above the current directory. Several projects can share one board: pass the same absolute `--db` everywhere; a new task's project defaults to its parent's, then to the repository holding the board. `nawaban backup` copies the board into `backups/` beside it.

The board UI is committed already built, in `nawaban/webui/dist`. Rebuild it only after changing the frontend ([webui README](../nawaban/webui/README.md)).

Launch the board with `bash "$NAWABAN_HOME/nawaban/board-up.sh"`. `NAWABAN_BOARD_PORT` and `NAWABAN_BOARD_HOST` select the listener; `NAWABAN_DB` selects its board.

## Session identity

Commands that write as someone (`claim`, `close`, `event`) take the identity from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets in every session, then from `NAWABAN_OWNER`. Codex sets no session variable, so set `NAWABAN_OWNER` to a stable name in the environment Codex runs commands in; without either variable those commands refuse and say so.
