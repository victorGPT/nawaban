# Changelog

## Unreleased

- Remove the compatibility names that need no data migration: the hidden verbs `kin`, `advance`, `letter`, `letters` and `letter-read`; the `--origin` and `--origin-file` flags; the `FOREMAN_OWNER` and `FOREMAN_ALLOW_BRANCH_SWITCH=1` inputs; all `WORKOS_*` environment variables; and the root `foreman_card.py` / `foreman_liveness.py` import shims. Old verbs and flags fail as unknown input; old environment variables are ignored, so rename them where you set them (for example `WORKOS_CONTEXT_BANNER` in Claude settings and `WORKOS_DB` in a launchd backup job). `tests/test_glossary.py` fails if an alias registration, a retired environment name, a root shim, or a hint to a retired verb returns.
- Prefer `NAWABAN_OWNER` for the session identity and `NAWABAN_ALLOW_BRANCH_SWITCH=1` for the branch gate escape prefix. The board's inbox and capture writes now set `NAWABAN_OWNER`, so an exported owner cannot replace their fixed identities.
- Rename the project setup skill from `foreman-pattern` to `nawaban-setup`. Reinstall or relink the skill if you linked it by its old directory name.

- Add English and Chinese board languages, selected from the browser language and switchable in the sidebar with a saved preference. Preserve existing Chinese wording and stored API values. Show Assigned separately from In progress, and enforce English message registration in CONTEXT.md.

- Session state uses `NAWABAN_STATE_DIR`, then `~/.local/state/nawaban`. If the new session registry is absent, reads fall back to `~/.claude/foreman/session-registry.json`; the next registration preserves those entries in the new file and leaves the old file untouched. An existing new registry takes precedence.
- Stale reports and daily markers independently fall back to `~/.claude/state` when their new files are absent. A legacy marker for today prevents duplicate background checks; subsequent checks write only to the current state directory and leave legacy files untouched.
- `init` reuses an existing `.foreman/workos.db` when `.nawaban/nawaban.db` is absent, preventing a second board from splitting task history. Explicit database selections still take precedence.
- Board writes require JSON and validate Host and Origin against the local listener before invoking the task CLI.
- Prefer `deps`, `transition`, `notify`, `notifications`, and `notify-read`. `fanout` and `wrapup` are unchanged.
- Rename `tasks.origin` to `context` with an idempotent `ALTER TABLE ... RENAME COLUMN` migration. New boards use `context`. Board APIs, web UI, context loading, and imports consume `context`; detail headings are unchanged. Existing boards migrate on their next CLI command, so upgrade all readers and writers together; do not point this version at a board still served by the legacy runtime.

- Rename the runtime directory, imports, CLI display name, board branding, and source references from `workos` to `nawaban`. CLI subcommands, enum values, and database schemas are unchanged.
- Prefer `NAWABAN_DB`, `NAWABAN_BOARD_PORT`, and `NAWABAN_BOARD_HOST`. The same applies to the home, context-banner, and decision-channel settings.
- Use `.nawaban/nawaban.db` for new boards in the shared Git checkout or nearest board directory. Reads and `init` reuse `.foreman/workos.db` when the new database is absent. An explicit `--db` or database environment override still takes priority. Database files are not moved by this path selection.
- Derive board startup and reconciliation paths from the checkout, current directory, and explicit configuration instead of personal directories. Keep rotation of legacy `workos-*.db` backups and explicitly selected legacy board executables compatible.
