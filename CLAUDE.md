## Agent skills

### Issue tracker

Specs and tickets live on the nawaban board (project `nawaban`), used through its CLI only. See `docs/agents/issue-tracker.md`.

### Triage labels

Three labels (`needs-info`, `ready-for-agent`, `ready-for-human`), recorded as `triage: <label>` note events on a task. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Updating the local plugin

When a change that touches no schema has merged into `main`, run `git -C ~/.nawaban/plugin pull --ff-only` yourself. A change that touches the schema or migrates data: ask the user first.
