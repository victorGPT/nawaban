# Reference UI port validation

Task: `NAWABAN-UIPORT-017`. Baseline: `20d196b7001b6db92a4b5ccdbcd8a468656ca155`.

The React frontend now uses the reference-kanban light canvas and rounded outer frame, a 238px sidebar, four visual lanes, grouped list rows, and a 1000px detail sheet. The detail body uses a 715px reading area and 285px property rail with separate scrolling; below 800px they stack. BoardUI/Base UI still supplies controls and overlay behavior. Backend lifecycle states and API/data-write behavior are unchanged. Assigned tasks share the In progress lane and retain an explicit label.

## Local verification

Commands run from `nawaban/webui`:

| Command | Actual result |
| --- | --- |
| `npm run build` | PASS; existing bundle-size warning remains |
| `npm run lint` | PASS, exit 0; existing React warnings remain |
| `npm test` | 25 passed |
| `npm run test:components` | 52 passed in 9 files |
| `npm run test:proxy` | 1 passed |

From repository root:

- `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests`: **367 passed, 3 skipped, 9 subtests passed**.
- `uv run --no-project --python 3.12 --with pytest --with pyyaml python tests/run.py`: **34 passed, 0 failed, 0 skipped**, including its pytest suite (**289 passed**).
- After the locale-label edit, `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests/test_glossary.py`: **3 passed**.
- Impeccable mechanical detector on changed UI targets returned `[]`.

The new component tests cover all five backend states in four visual lanes, independent decision-button actions, bilingual Assigned labels, grouped-list keyboard navigation, search/date controls remaining available after a failed read, and sidebar-toggle focus restoration. Existing tests retain project scope, unassigned projects, dialogs/focus, localization, answers, and unknown-outcome retry boundaries.

## Browser evidence

Headless Google Chrome used isolated browser contexts at **1440 x 1000** and **390 x 844**. The initial Vite preview was port 8848. Final checks used the actual Python board server at **8849**, loading built `webui/dist` against an isolated SQLite backup. Production 8813 and reference 8847 were only read. No real inbox answer was submitted.

Measured light-theme values:

| Property | Reference 8847 | Python-served worktree 8849 |
| --- | --- | --- |
| Canvas | rgb(232, 232, 231) | rgb(232, 232, 231) |
| Frame at 1440 x 1000 | 1376 x 904, x32/y48 | 1376 x 904, x32/y48 |
| Frame radius | 25px | 25px |
| Sidebar | 244px in final prototype CSS | 238px, as explicitly required by the task |
| First card radius / height | 14px / 149px | 14px / 149px |
| Card title | 15px, line-height 1.7 | 15px, line-height 1.7 |
| Detail sheet / property rail | 1000px / 285px in source | 1000px / 285px measured |

Browser checks passed: four lanes; task detail Escape/focus restoration; module DAG cards and dependency paths; language toggling; no-project route; mobile sidebar/project dropdown; mobile single-column detail; no shell horizontal overflow; grouped list column widths; dark palette (`rgb(18, 20, 22)` canvas). The mobile inbox fixture selected an option and emitted exactly one intercepted answer request. This is fixture evidence, not a live decision.

Raw screenshots, browser scripts/results and logs are retained in the task artifact directory linked from the board. The original prototype detail grid did not become visible within 30 seconds in the capture attempt; a direct scoped GET returned a task-not-in-project error. Its layout comparison therefore relies on source CSS, not a successful live detail screenshot.

## Remaining differences and delivery boundary

- The sidebar follows the explicit 238px task requirement instead of the prototype's final 244px override.
- React keeps the existing recent-completions API window, rather than the prototype's larger historical task list. Status-signal meanings and independent decision actions remain those of the React app.
- The toolbar retains the working date/module filters; theme/language controls and the full module DAG/inbox views remain available. Prototype-only refresh/density/attention-filter controls are not introduced by this styling port.
- The reference prototype and its process were not modified. Backend source, schema and API contracts were not modified.
- Production 8813 has not received this worktree build. Remote CI, integration/merge, and human visual acceptance are **not verified** by the local results above.
- Independent Claude review identified four Low issues: sidebar-toggle focus, failed-read controls, dark primitive colors, and ordinary dialog radius. All four were fixed and passed targeted Chrome checks. The bounded verdict pass is recorded in the task handoff artifact.
