# Runtime, data, and identity

## Finding the implementation

Run `python3 "$NAWABAN_HOME/nawaban/cli.py" <verb>` from a verified nawaban source checkout, and look up flags with `--help`. This skill's real path is `<nawaban root>/skills/nawaban/SKILL.md`; resolve symlinks first, then walk up to that root. For a short command, define it only for the current process:

```bash
export NAWABAN_HOME="<verified absolute path of the nawaban root>"
nawaban() { python3 "$NAWABAN_HOME/nawaban/cli.py" "$@"; }
```

When installed as a Claude Code plugin, `NAWABAN_HOME` is the plugin root (`CLAUDE_PLUGIN_ROOT` inside hook processes). `NAWABAN_HOME` locates the source and the optional helpers; it does not select the task database. Read [Install and integration](../../../README.md#install-as-a-plugin) only when installing or configuring hooks. When the installation is incomplete, say which entry point is missing; ordinary tasks leave global configuration alone.

## Choosing the target board

The task database the project declares is the source of truth. The CLI's order is an explicit `--db` → `NAWABAN_DB` → `.nawaban/nawaban.db` in the Git shared main checkout (falling back to `.foreman/workos.db` when missing) → the board directory found by walking up from the current directory. When calling across projects or from the install directory, pass `--db <absolute path of target db>` so you do not hit the install project's own board.

When several projects share one database, pass `--project <name>` when creating a task. Without it, the project comes from the directory that holds the current repository's board, then from the board directory of the explicit database; a split task inherits its parent's project. The Web project filter only narrows what is shown; it does not switch databases.

Read the current task and the database structure through the existing Web/API or SQLite with `mode=ro`; check the schema before querying when needed. The CLI has no `show` verb. Most CLI verbs upgrade the schema first, so a strictly read-only check uses a read-only connection; `--help` does not open the database.

Write tasks through the CLI, and keep the database and personal state local and private. Use `init` only when explicitly connecting a new board; when an old database cannot be found, check the path first. Verification, rehearsals, and SessionStart smoke tests use a separate temporary database and a test identity: SessionStart reclaims tasks, so never rehearse on the real board.

## Session identity

Writes pass the real `NAWABAN_OWNER` and `CLAUDE_CODE_SESSION_ID` from the runtime environment. The CLI owner is the former; without it, the owner is derived from the session as `ac:<full session ID>`. Verbs that need a session refuse to run without the latter. The CLI does not read tmux window names by itself.

When resuming, confirm ownership from the task's sessions, handoff, and worktree. Resuming an existing session keeps its identity; a new session uses its own real identity. A Claude Code session can run `claude --resume <session-id>` from its original working directory; other agents use their own resume features.

Compatibility fallbacks for old configuration are described in the repository root `CHANGELOG.md`; `init` creates `.nawaban/nawaban.db` by default.
