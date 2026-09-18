# Task inactivity on cards

Board and module cards show task event inactivity independently of the session liveness dot. Waiting and inactivity text share one chip in the existing footer, with ellipsis and a full-text hover tooltip. No extra line is inserted between title and task ID. Finished/cancelled tasks and fresh tasks without a waiting reason omit the chip.

`nawaban/webui/src/lib/task-staleness.ts` owns the thresholds in seconds: show after 24 hours, yellow after 3 days, rose after 7 days. English uses singular for one day. Unknown waiting values retain the server identifier. Cards share a 60-second clock, including when API refreshes fail.

`active_at` uses the latest `task_events.created_at`, falling back to `started_at` and then `created_at`. Both API projections use this ordering. Older module responses may omit the timestamp without suppressing waiting reasons. No schema or data-write changes.

## Density and review corrections

The footer stays outside normal document flow. The existing two-line title slot keeps kanban cards equal within each density; card height is not fixed. Normal vertical padding is 18px and `.board-compact` uses 10px, preserving the density switch. With the display controls from #20, hiding the task ID keeps its footer slot through a one-line CSS spacer; module tags and attention share the absolute footer. Narrow-column chip truncation is unchanged.

Director verify #7899 accepted the previous footer, pluralization and unknown-waiting corrections, but identified the fixed 124px height as blocking compact density. Removing that fixed height restores the 16px difference without introducing another row. One-off measurement logs and manual fixtures have been removed from the repository; the automated component tests remain.

## Real-browser verification, 2026-09-19

After rebasing onto main `6e669003c3bd7ea34ed599829fb9079b871bba81` (including #20 and #22), local ego-browser measured the real board at a 1321 x 803 viewport using `getBoundingClientRect()`. The actual Display controls switched density and all four ID/module visibility combinations. Eight seeded tasks in a temporary database covered no indicator, waiting only, inactivity only, both indicators, short/long titles, all waiting reasons, and Assigned with an extra tag.

| Locale | Density | Measurements across four field combinations | Height in CSS pixels |
|---|---|---|---|
| Chinese | Normal | 32 | 123.5 for every card (approximately 124) |
| Chinese | Compact | 32 | 107.5 for every card (approximately 108) |
| English | Normal | 32 | 123.5 for every card (approximately 124) |
| English | Compact | 32 | 107.5 for every card (approximately 108) |

All 128 measurements were internally equal within each density, with a 16px difference between densities. Footers stayed within cards and clear of rendered task-ID text. Before the correction, both densities measured 124px. Earlier local component-page measurements also covered three board widths and a long unknown waiting reason in both languages and densities. These are agent-operated local browser checks, not deployment or human acceptance. No manual fixture or raw measurement log is retained in the repository.

## Validation

- `npm --prefix nawaban/webui run test:components`: 78 passed.
- `npm --prefix nawaban/webui run build` and `run lint`: passed, with existing warnings.
- `npm --prefix nawaban/webui test`: 31 passed.
- `npm --prefix nawaban/webui run test:proxy`: 1 passed.
- `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests`: 426 passed, 3 skipped, 9 subtests passed.
- `uv run --no-project --python 3.12 --with pytest --with pyyaml python tests/run.py`: 34 groups passed.

No merge or deployment is performed. Director re-review targets the updated PR head.
