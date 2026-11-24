## Agent skills

### Issue tracker

Specs and tickets live on the nawaban board (project `nawaban`), used through its CLI only. See `docs/agents/issue-tracker.md`.

### Triage labels

Three labels (`needs-info`, `ready-for-agent`, `ready-for-human`), recorded as `triage: <label>` note events on a task. See `docs/agents/triage-labels.md`.

### OKR

This repository keeps its own `docs/agents/okr.toml`, so every ticket here declares its KR impact before it closes as done: register it as you claim (`nawaban claim <ID> --o … --kr …`), and a docs-only or pure-infrastructure ticket declares `--o 无`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Code style

No comments in code. Names and structure carry the intent: a constant named for what it bounds, a function named for the invariant it keeps, steps ordered so the order reads as the reason.

## Updating the local plugin

When a change has merged into `main`, run `git -C ~/.nawaban/plugin pull --ff-only && sh ~/.nawaban/plugin/herdr/install-mod.sh` yourself (the second step copies the Herdr panel into `~/.config/herdr-app/mods`). A change that touches the schema or migrates data gets the same, after `python3 ~/.nawaban/plugin/nawaban/cli.py backup` first (decision-maker 11-25: 「更新更新，不要怕」).
