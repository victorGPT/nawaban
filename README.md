# nawaban

Before a building rises, the foreman stretches ropes on bare ground to mark the load-bearing axes: 地縄 (ji-nawa). An agent facing a chaotic request does the same: draws the lines. **Before the structure arises, draw the line.** / **在万物构筑之前,先拉绳定界。**

nawaban is a task coordination workspace for agents and people: tasks, ownership, dependencies, human asks, and delivery evidence share one board.

The runtime and skill use the nawaban name. CLI subcommands and database schemas retain their existing contracts; the bilingual [glossary](CONTEXT.md) defines the product vocabulary. This snapshot is not yet a portable plugin installation.

| Path | Contents |
| --- | --- |
| `nawaban/` | Python CLI, SQLite runtime, board server, `board-up.sh`, and WebUI source |
| `skills/nawaban/` | Task coordination skill and references |
| `hooks/` | `foreman_branch_gate.sh`, `foreman_maintree_watch.sh`, and `foreman_session_start.py` |
| `nawaban/guard.py`, `nawaban/compile_gate_headless.sh` | The other two live hooks, preserved at their runtime paths |
| `tests/test_glossary.py` | CLI terminology coverage check |

Run the glossary check from this repository with an existing Python environment containing pytest:

```sh
python3 -m pytest -q tests/test_glossary.py
```

The test uses only the Python standard library and does not import or execute the runtime. Missing subcommands are named in the failure message.

Runtime data, logs, caches, installed dependencies, compiled WebUI output, the excluded DAG prototype and graph experiment, and the three retired hooks are omitted. No npm or pip distribution is introduced.

Licensed under the [MIT License](LICENSE).

## Run from a checkout

Set `NAWABAN_HOME` to this checkout and define the CLI in your shell (no package installation required):

```sh
export NAWABAN_HOME="$(pwd)"
nawaban() { python3 "$NAWABAN_HOME/nawaban/cli.py" "$@"; }
```

Run `nawaban init` in the project to create `.nawaban/nawaban.db`, then use `nawaban inbox`. An explicit `--db` takes priority over `NAWABAN_DB`; existing legacy configuration remains supported as described in [CHANGELOG.md](CHANGELOG.md). Initialization uses the new default path unless an explicit database path or environment override is supplied.

Launch the board with `bash "$NAWABAN_HOME/nawaban/board-up.sh"`. `NAWABAN_BOARD_PORT` and `NAWABAN_BOARD_HOST` select the listener; `NAWABAN_DB` selects its board. Linked Git worktrees resolve the board in the shared main checkout.

## Install as a plugin

The same checkout is a Claude Code plugin and a Codex plugin; both read `hooks/hooks.json`.

- **Claude Code:** `claude --plugin-dir /path/to/nawaban`.
- **Codex:** add the checkout as a local marketplace in `~/.codex/config.toml`, then install it. Codex copies the plugin into its cache, so run `codex plugin add` again after pulling.

  ```toml
  [marketplaces.nawaban]
  source_type = "local"
  source = "/path/to/nawaban"
  ```

  ```sh
  codex plugin add nawaban@nawaban
  ```

The gates act only in a Git main checkout that has a nawaban board, for a session with an identity (`FOREMAN_OWNER`, a tmux window or a session id). Files under `.nawaban/` and `.foreman/`, and checkouts containing `.foreman/ALLOW_MAINTREE_EDIT`, stay writable. In `Bash`, the write gate catches common file writes (`>`/`>>` redirects, `tee`, `sed -i`) but not arbitrary scripts; the merge gate inspects `gh pr merge` commands, and the branch gate inspects `git checkout` / `git switch`.

| | Claude Code | Codex |
| --- | --- | --- |
| Session banner | Shown at session start | Shown at session start (as developer context) |
| Main-checkout write gate | Blocks `Edit` / `Write` / `MultiEdit` | Blocks `apply_patch`; target paths are read from the patch headers |
| Branch and merge gates | Block the `Bash` command | Block the `Bash` command |
| Session identity | `CLAUDE_CODE_SESSION_ID` | `session_id` from the hook input; Codex sets no session variable |
| Hook trust | Hooks run once the plugin is enabled | Codex asks you to trust the plugin hooks before they run |
| Headless compile gate (Stop) | Active only for `claude -p` | Inactive: the gate checks for Claude's headless entrypoint |
| Main-checkout dirt watch (Stop) | Prints a warning at turn end | Registered; its output in Codex is not verified |
