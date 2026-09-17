# nawaban

Before a building rises, the foreman stretches ropes on bare ground to mark the load-bearing axes: 地縄 (ji-nawa). An agent facing a chaotic request does the same: draws the lines. **Before the structure arises, draw the line.** / **在万物构筑之前,先拉绳定界。**

nawaban is a task coordination workspace for agents and people: tasks, ownership, dependencies, human asks, and delivery evidence share one board.

The runtime and skills use the nawaban name. CLI subcommands and database schemas retain their existing contracts; the bilingual [glossary](CONTEXT.md) defines the product vocabulary. The checkout ships as a Claude Code and Codex plugin.

| Path | Contents |
| --- | --- |
| `nawaban/` | Python CLI, SQLite runtime, board server, `board-up.sh`, and WebUI source |
| `skills/` | Task coordination (`nawaban`), project setup (`foreman-pattern`), and session handoff (`nawaban-wrapup`) skills |
| `hooks/` | `foreman_branch_gate.sh`, `foreman_maintree_watch.sh`, and `foreman_session_start.py` |
| `nawaban/guard.py`, `nawaban/compile_gate_headless.sh` | The other two live hooks, preserved at their runtime paths |
| `tests/test_glossary.py` | CLI terminology coverage check |

Run the glossary check from this repository with an existing Python environment containing pytest:

```sh
python3 -m pytest -q tests/test_glossary.py
```

The test uses only the Python standard library and does not import or execute the runtime. Missing subcommands are named in the failure message.

Runtime data, logs, caches, installed dependencies, compiled WebUI output, the excluded graph experiment, and the three retired hooks are omitted. No npm or pip distribution is introduced.

Licensed under the [MIT License](LICENSE).

## Run from a checkout

Set `NAWABAN_HOME` to this checkout and define the CLI in your shell (no package installation required):

```sh
export NAWABAN_HOME="$(pwd)"
nawaban() { python3 "$NAWABAN_HOME/nawaban/cli.py" "$@"; }
```

Run `nawaban init` in the project to create `.nawaban/nawaban.db`, then use `nawaban inbox`. An explicit `--db` takes priority over `NAWABAN_DB`; existing legacy configuration remains supported as described in [CHANGELOG.md](CHANGELOG.md). Initialization uses the new default path unless an explicit database path or environment override is supplied.

Build the board UI once per checkout with `npm ci && npm run build` in `nawaban/webui` (the build output is not committed; without it the board serves the built-in fallback page). The Modules view includes the dependency network.

Launch the board with `bash "$NAWABAN_HOME/nawaban/board-up.sh"`. `NAWABAN_BOARD_PORT` and `NAWABAN_BOARD_HOST` select the listener; `NAWABAN_DB` selects its board. Linked Git worktrees resolve the board in the shared main checkout.

### Projects on a shared board

Use `create --project <name>` to select a task's project when several repositories share one database. Without this option, a new task derives its project from the current repository's board directory, falling back to the explicit database's board directory; `--split-from` inherits the parent task's project. Project selection filters the board and inbox without changing the selected database.

For legacy cards, use `meta <task-id> --set-project <name>` to fill an empty project with an audit event. Existing projects cannot be overwritten; repeat attempts are rejected without another write. Back up a live board with `backup` before backfilling it. Select **No project** to find unassigned cards and their asks in the board, modules, and inbox. API reads use `?unassigned=1` for this filter; omitted or empty `project` still means all projects.

Task context supplied through `create --context` or `--context-file` must use a Markdown unordered list, with one point per item. This format is checked before the task is written. Existing records remain readable.

### Optional module suggestions

With `TYPESAFE_API_KEY` set, `create` without `--epic` can print one module suggestion to stderr after the task has been committed. It never fills `epic`. An explicit module or a module inherited through `--split-from` skips this suggestion.

The request uses TypeSafe Choice with all existing module names, up to three recent distinct task titles per module, and a “none” option. It sends the new title, the first 4,000 characters of its background, and up to ten success criteria (500 characters each). It uses one extra request, without retries. A unique module probability of at least 0.9 is required; missing credentials, unavailable or malformed responses, uncertainty, and empty catalogs remain silent. Boards with more than 254 modules skip the request to stay within the [255-option Choice limit](https://docs.typesafe.ai/primitives/choice).

See [the evaluation report](docs/epic-hint-evaluation.md) for coverage, error rates, timing, and reproduction instructions. Suggestions are fallible; choose the module yourself.

### Optional prerequisite suggestions

With `TYPESAFE_API_KEY` set, `create` can also suggest one unfinished prerequisite
after the new task commits. Candidates stay within the same project, prefer the
same module, then recent activity, and are capped at 25. A top Noul score of at
least 0.60 is required. The command only prints a suggestion; it never adds an edge.

Title/success, module, and prerequisite suggestions share one five-second waiting
budget. Missing credentials, unavailable services, uncertain answers, and expired
budgets remain silent and leave the created task intact. At the owner-selected
threshold, 22/120 cards received a hint: 13/22 matched a direct dependency and
20/22 matched an upstream dependency through the current graph. The closure
measure includes later-recorded edges and has mild temporal leakage;
see [the dependency evaluation](docs/dependency-hint-evaluation.md) for request
success rates, false-hint rates, candidate recall ceilings, and limitations.

## Install as a plugin

The same checkout is a Claude Code plugin and a Codex plugin; both read `hooks/hooks.json`.

- **Claude Code:** `claude plugin marketplace add /path/to/nawaban`, then `claude plugin install nawaban@nawaban`. For a one-off session, `claude --plugin-dir /path/to/nawaban` also works. The installed copy updates with `claude plugin update nawaban@nawaban`.
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

## Verification

Run `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests` after building the UI. Test configuration isolates local task data and credentials and supplies subprocess imports. PyYAML is optional: only historical Markdown/YAML parsing tests skip when it is absent. To cover that optional path too, run `uv run --no-project --python 3.12 --with pytest --with pyyaml python tests/run.py`. Frontend checks are defined in `nawaban/webui/package.json`.

To verify an existing board without migrating it, run `python3 scripts/verify_database_copy.py /path/to/board.db`. It opens the source read-only, migrates a temporary backup twice, and verifies exact schema and row preservation plus integrity and foreign keys. A separate disposable copy exercises create, claim, the context detail API, and project filters.

Session registry and reconciliation reports use `NAWABAN_STATE_DIR`, then the legacy `WORKOS_STATE_DIR`, then `~/.local/state/nawaban`. When the new registry is absent, session lookup reads the previous `~/.claude/foreman/session-registry.json`; the next registration preserves its entries in the new file without modifying the old one.
