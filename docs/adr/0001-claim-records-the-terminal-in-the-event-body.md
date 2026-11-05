# A claim records its Herdr terminal in the status event body, not a column

The Herdr panel lists windows, so it must know which terminal holds a task; the session id alone does not say, because Herdr's terminal list carries no session id. When `HC_TERMINAL_ID` is set in a Claude Code session, `claim` (and `claim --take`, and the holder re-claiming from another terminal) appends ` · terminal <id>` to its status event body, and `json board` derives each held task's `terminal` from the holding session's latest claim (`→in_progress`) event, or `null` if that event names none. We chose this over a `tasks.terminal` column so the schema stays as it is: no migration, and old boards and the plugin copy keep working.

## Considered Options

- **A `terminal` column on `tasks`**: rejected, it changes the schema and needs a migration for a hint that only the panel reads.
- **Guess the window from the terminal's cwd**: rejected, several windows of one project share a cwd.

## Consequences

- The terminal is a reading of history, not state: a release or close clears the session, so `terminal` is `null` without anyone erasing it.
- `NAWABAN_OWNER` sessions and sessions outside Herdr record no terminal.
