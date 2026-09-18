# Reference toolbar follow-up

Scope: NAWABAN-UIPORT-017, coord 7830, based on `cf1d3a19cc71dabfaeb0c714c578c071bff11a02` (PR #17).

- Restore manual refresh, a waiting-state filter, the prototype's rightmost panel icon, and the visible `/` search shortcut. The prototype panel icon invokes `density`: it switches compact spacing; it does not open another sidebar. The existing updated-date filter remains available.
- Display the selected project/module, visible task count, last successful client read time, and the shared 30-second polling interval. Manual refresh coalesces pending reads and restarts the interval. Failed reads do not advance the success timestamp. The changing clock is outside the screen-reader live region.
- Remove module-card lifecycle badges while retaining blocked/dependency tags and existing session signals. Board/list lifecycle labels remain unchanged.

## Local validation

| Command | Result |
|---|---|
| `npm --prefix nawaban/webui run build` | Pass; existing large-bundle warning remains |
| `npm --prefix nawaban/webui run lint` | Pass; existing warnings remain |
| `npm --prefix nawaban/webui test` | 26 passed |
| `npm --prefix nawaban/webui run test:components` | 55 passed |
| `npm --prefix nawaban/webui run test:proxy` | 1 passed |
| `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests` | 372 passed, 3 skipped, 9 subtests passed |
| `uv run --no-project --python 3.12 --with pytest --with pyyaml python tests/run.py` | 34 passed; nested pytest 294 passed |

An isolated Chrome harness used port 8849 and a SQLite backup, not the live database. At 1440 × 1000, manual refresh made one board request; compact mode reduced the sampled card from 149 to 133 px. Waiting-state filtering, source counts, `/` focus, language switching, and dark mode worked. At 390 × 844, document client/scroll widths were both 390 px. No page JavaScript errors were observed. Component fixtures additionally cover nonempty waiting filters, module filtering, failed reads/retries, and preserved dependency tags.

Claude reviewed a frozen patch and source snapshot. Confirmed live-region and retry-status findings were fixed and covered by component assertions. Its follow-up allowed merging and identified an initial-failure loading label; that label was subsequently corrected with a focused regression assertion. The reported focus-loss and midnight-format concerns were not reproduced in installed Chrome; these remain browser-specific verification limits, not confirmed defects. Actual VoiceOver speech was not tested.

Screenshots, browser measurements, and Claude review artifacts are attached to the task under `.foreman/artifacts/NAWABAN-UIPORT-017/followup/` in the WorkOS board workspace. Port 8813 deployment and merging remain with the director; the protected 8847 prototype was not changed.
