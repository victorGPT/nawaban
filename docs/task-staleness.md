# Task inactivity on cards

Board and module cards show task event inactivity independently of the session liveness dot. Waiting and inactivity text share one chip in the existing footer, with ellipsis and a full-text hover tooltip. No extra line is inserted between title and task ID. Finished/cancelled tasks and fresh tasks without a waiting reason omit the chip.

`nawaban/webui/src/lib/task-staleness.ts` owns the thresholds in seconds: show after 24 hours, yellow after 3 days, rose after 7 days. English uses singular for one day. Unknown waiting values retain the server identifier. Cards share a 60-second clock, including when API refreshes fail.

`active_at` uses the latest `task_events.created_at`, falling back to `started_at` and then `created_at`. Both API projections use this ordering. Older module responses may omit the timestamp without suppressing waiting reasons. No schema or data-write changes.

## Density and review corrections

The footer stays outside normal document flow. The existing two-line title slot keeps kanban cards equal within each density; card height is not fixed. Normal vertical padding is 18px and `.board-compact` uses 10px, preserving the density switch. Narrow-column chip truncation is unchanged.

Director verify #7899 accepted the previous footer, pluralization and unknown-waiting corrections, but identified the fixed 124px height as blocking compact density. Removing that fixed height restores the 16px difference without introducing another row. One-off measurement logs and manual fixtures have been removed from the repository; the automated component tests remain.

## Real-browser verification, 2026-09-19

Local ego-browser measured the real TaskCard and production CSS using `getBoundingClientRect()` at a 1331 x 813 viewport. Each locale/density covered 24 cards across board widths 940, 1280 and 1600, including no indicator, waiting only, inactivity only, both indicators, long titles, all waiting reasons, and a long unknown reason alongside Assigned.

| Locale | Density | Cards | Height in CSS pixels |
|---|---|---|---|
| Chinese | Normal | 24 | 123.5 for every card (approximately 124) |
| Chinese | Compact | 24 | 107.5 for every card (approximately 108) |
| English | Normal | 24 | 123.5 for every card (approximately 124) |
| English | Compact | 24 | 107.5 for every card (approximately 108) |

Both density groups were internally equal and differed by 16px. Footers stayed within cards and clear of task IDs. Before this correction, both densities measured 124px. This is agent-operated local browser evidence, not deployment or human acceptance.

## Validation

- `npm --prefix nawaban/webui run test:components`: 63 passed.
- `npm --prefix nawaban/webui run build` and `run lint`: passed, with existing warnings.
- `npm --prefix nawaban/webui test`: 26 passed.
- `npm --prefix nawaban/webui run test:proxy`: 1 passed.

No merge or deployment is performed. Director re-review targets the updated PR head.
