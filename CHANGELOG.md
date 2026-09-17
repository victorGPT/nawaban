# Changelog

## Unreleased

- Prefer `deps`, `transition`, `notify`, `notifications`, and `notify-read`. The old verbs remain hidden aliases with identical output; `fanout` and `wrapup` are unchanged.
- Rename `tasks.origin` to `context` with an idempotent `ALTER TABLE ... RENAME COLUMN` migration. New boards use `context`; `create --context` and `--context-file` retain `--origin` and `--origin-file` aliases. Board APIs, web UI, context loading, and imports consume `context`; detail headings are unchanged. Existing boards migrate on their next CLI command, so upgrade all readers and writers together; do not point this version at a board still served by the legacy runtime.

- Rename the runtime directory, imports, CLI display name, board branding, and source references from `workos` to `nawaban`. CLI subcommands, enum values, and database schemas are unchanged.
- Prefer `NAWABAN_DB`, `NAWABAN_BOARD_PORT`, and `NAWABAN_BOARD_HOST`; the corresponding `WORKOS_*` variables remain fallback inputs. The same precedence applies to the existing home, context-banner, and decision-channel settings. Compatibility is retained for at least one release cycle.
- Use `.nawaban/nawaban.db` as the default database in the shared Git checkout or nearest board directory. Reads fall back to `.foreman/workos.db` when the new database is absent. `init` creates the new path; an explicit `--db` or database environment override still takes priority. Existing database files are not moved or migrated by the rename.
- Derive board startup and reconciliation paths from the checkout, current directory, and explicit configuration instead of personal directories. Keep rotation of legacy `workos-*.db` backups and explicitly selected legacy board executables compatible.
