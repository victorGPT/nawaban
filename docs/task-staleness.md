# Task inactivity on cards

Board and module cards display the waiting reason and elapsed task inactivity independently of the session liveness dot. Finished and cancelled tasks omit this row; fresh tasks with no waiting reason also omit it.

`nawaban/webui/src/lib/task-staleness.ts` owns `TASK_STALE_THRESHOLDS` (seconds): show after 24 hours, yellow after 3 days, rose after 7 days. The label counts whole days. Cards share one 60-second clock, so time advances even while API refreshes fail.

`active_at` uses the latest `task_events.created_at`, falling back to `started_at` and then `created_at` for tasks without events. Both API projections use this ordering. Module responses from older servers can omit the field; waiting reasons remain visible without inventing inactivity. There are no schema or data-write changes.

## Verification

- Frontend build and lint passed (existing component lint warnings and bundle-size warning remain).
- Node model/API tests: 26 passed. Dev-proxy test: 1 passed.
- Component tests: 61 passed, including six new cases for thresholds, waiting reasons, live translation, terminal/fresh/missing activity, keyboard selection, module data, and the shared clock.
- Python suite: initially 372 passed / 3 skipped with one new fixture failure (missing required event author); after fixing the fixture, the focused activity projection test passed.
- Browser visual verification is unavailable: Aside daemon is unreachable and the computer-use provider reports no available browser. No screenshot or human acceptance is claimed.
