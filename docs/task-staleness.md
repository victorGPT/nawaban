# Task inactivity on cards

Board and module cards display the waiting reason and elapsed task inactivity independently of the session liveness dot. Finished and cancelled tasks omit this row; fresh tasks with no waiting reason also omit it.

`nawaban/webui/src/lib/task-staleness.ts` owns `TASK_STALE_THRESHOLDS` (seconds): show after 24 hours, yellow after 3 days, rose after 7 days. The label counts whole days. Cards share one 60-second clock, so time advances even while API refreshes fail.

`active_at` uses the latest `task_events.created_at`, falling back to `started_at` and then `created_at` for tasks without events. Both API projections use this ordering. Module responses from older servers can omit the field; waiting reasons remain visible without inventing inactivity. There are no schema or data-write changes.

## Verification

- Frontend build and lint passed (existing component lint warnings and bundle-size warning remain).
- Node model/API tests: 26 passed. Dev-proxy test: 1 passed.
- Component tests: 61 passed, including six new cases for thresholds, waiting reasons, live translation, terminal/fresh/missing activity, keyboard selection, module data, and the shared clock.
- `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests`: 373 passed, 3 skipped, 9 subtests passed.
- `uv run --no-project --python 3.12 --with pytest --with pyyaml python tests/run.py`: 34 runner groups passed; embedded pytest: 295 passed.
- Isolated temporary-database HTTP smoke: Python serves built HTML, JS and CSS with HTTP 200; `/api/board` and `/api/modules` both preserve the fixture's 1/3/7-day ages and waiting reasons. This is HTTP integration evidence, not visual acceptance.
- Browser visual verification is unavailable: Aside daemon is unreachable and the computer-use provider reports no available browser. No screenshot or human acceptance is claimed.

## Independent review status

The fixed implementation review target was `0930f1d20b111afa984cd360927f9313250073d5..b6716e1` (subsequent commits only record validation). A source/diff packet was prepared for Claude with tools disabled.

- `claude --bare ... --model claude-sonnet-4-6`: exited 1 with `Not logged in · Please run /login`.
- `claude --safe-mode ... --model claude-sonnet-4-6`: no result after approximately 6 minutes; this attempt was terminated.
- `claude --safe-mode ...` using the configured default model: no result after approximately 3 minutes; this attempt was terminated.

No independent review verdict is available. PR remains a draft until Claude review is completed. The connection failure cause is not established.
