# Task inactivity on cards

Board and module cards display task event inactivity independently of the session liveness dot. Waiting and inactivity text share one chip in the existing footer; no extra line is inserted between title and task ID. Long labels use ellipsis with a full-text hover tooltip. Finished and cancelled tasks omit the chip; fresh tasks without a waiting reason also omit it.

`nawaban/webui/src/lib/task-staleness.ts` owns `TASK_STALE_THRESHOLDS` (seconds): show after 24 hours, yellow after 3 days, rose after 7 days. English uses singular for one day. Unknown waiting values retain the server identifier. Cards share one 60-second clock, including when API refreshes fail.

`active_at` uses the latest `task_events.created_at`, falling back to `started_at` and then `created_at` for tasks without events. Both API projections use this ordering. Older module responses can omit the timestamp; waiting reasons remain visible without inventing inactivity. No schema or data-write changes.

## Review correction: verify event 7873

The director's Claude review of PR #21 at `7f39980` found that an in-flow attention row broke the card height established in #19. A real browser reproduced heights of 123.5, 155.5 and 183.5 CSS pixels (rounding to 124/156/184). The revised chip occupies the absolute footer; kanban cards are explicitly 124px. The footer has a bounded right-side allocation and the task ID keeps separate space. English singular, unknown-waiting tests and the glossary table break were also corrected.

## Real-browser height verification

Run `npm --prefix nawaban/webui run dev -- --host 127.0.0.1 --port 8870` and open `/tests/card-height.html`. This isolated fixture renders the actual `TaskCard` and production CSS without calling the board API.

Local ego-browser measurements used `getBoundingClientRect()` with an observed 1331 x 813 viewport. Each locale/theme rendered 24 cards across board widths 940, 1280 and 1600 (card widths 208, 293 and 373px). Cases cover no chip, waiting only, inactivity only, combined waiting/inactivity, long titles, every waiting reason, and a long unknown reason alongside the Assigned tag.

- Chinese / light: 24 of 24 cards measured exactly 124px.
- English / light: 24 of 24 cards measured exactly 124px.
- English / dark: 24 of 24 cards measured exactly 124px.
- Chinese / dark: 24 of 24 cards measured exactly 124px.
- All footer bounds stayed inside their cards; task IDs did not overlap the footer. Long labels use ellipsis.

Raw before/after readings are in [task-staleness-height-measurements.json](task-staleness-height-measurements.json). This is agent-operated local real-browser evidence, not human acceptance or deployment verification.

## Checks for this revision

- `npm --prefix nawaban/webui run test:components`: 63 passed.
- `npm --prefix nawaban/webui run build`: passed (existing bundle-size warning).
- `npm --prefix nawaban/webui run lint`: passed (existing component warnings).
- `npm --prefix nawaban/webui test`: 26 passed.
- `npm --prefix nawaban/webui run test:proxy`: 1 passed.
- `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests/test_glossary.py tests/test_task_activity.py`: 4 passed.
- Original implementation backend checks: full pytest 373 passed / 3 skipped / 9 subtests; legacy runner 34 groups passed. This revision does not change backend code.

The director's earlier review remains FAIL for `7f39980`; these corrections await re-review at the new PR head. No merge is performed.
