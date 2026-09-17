# Runtime synchronization validation

## Current authority and scope

The delivery is rebased onto nawaban main `70a73c3d25b25ce3c088b8e47f80aeda59f8331d` (PR #11). `tasks.context`, `create --context`, and the canonical `deps`, `transition`, `notify`, `notifications`, and `notify-read` verbs are authoritative. Old CLI flags/verbs remain compatibility aliases; task APIs and persisted schema use `context`. The older source runtime is no longer a compatible writer for the migrated live database and was not used to write it during this revision.

The original feature sync used reference revision `e498cfe23563f70b4d35daa0656c78033449cf62`: project attribution/filtering, current board and module network, inbox policy, task-content validation, runtime helpers, and bundled skills. Project selection filters one shared database. NAWABAN settings retain precedence over supported WORKOS compatibility inputs.

Plugin manifests, marketplace, hooks.json, Codex apply_patch support, and all five advisory TypeSafe paths remain. The standalone task DAG, its vendor/license, route, buttons and keyboard shortcut were removed by the subsequent scope decision; module dependency networks and static-path traversal protections remain.

## Review corrections and evidence

| Review request | Result and evidence |
| --- | --- |
| Rebase and context authority | CLI, SQL, detail APIs, content policy, frontend model/components and inherited test fixtures use context. New verbs and hidden aliases retain their main tests. A fresh live backup passed create/claim/detail/project checks without schema changes. |
| Direct pytest without PyYAML | `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests`: **304 passed, 3 skipped, 9 subtests**. Skips: optional legacy Markdown session display, historical Markdown import, and YAML skill frontmatter. The inherited loader separately skips only its YAML fallback subcase when unavailable. |
| Public-source cleanup | Replaced live-board task samples and title examples with fictional reading/garden fixtures. Removed private migration groups and default module selection; removed machine-specific launcher commentary. Tracked/public source scan for the review's private identifiers and machine paths: zero matches. |
| Initialize an existing legacy board | Regressions first reproduced a second database and an unupgraded legacy schema. Init now reuses the existing legacy file, migrates old columns, preserves its task/context, and still prefers an already-existing primary board or explicit selection. All **12 path regressions passed**, including an old origin schema missing project. |
| Cross-site write protection | A real HTTP attack initially returned 200 and invoked the CLI. **74 HTTP regressions passed** after the fix, including IPv4/IPv6, real temporary-DB answer/repeat rejection, rejected Host/Origin/media types, and unknown-outcome handling. |
| Registry relocation compatibility | Two regressions first reproduced lost old entries. Reads fall back to the legacy registry only while the new one is absent; registration preserves old entries in the new file, and leaves the old file unchanged. Existing new state wins. CHANGELOG documents this behavior. |

The write boundary requires exactly one `application/json` Content-Type and a Host matching loopback or the concrete listener address at its port. Browser Origin must match that HTTP Host exactly; opaque, foreign or cross-port origins are rejected before CLI execution. Origin-less requests require a loopback connection and loopback Host. Forwarded headers do not expand trust. Wrong media types return 415; origin/host failures return 403. Timeout remains an unknown write outcome and is never automatically retried. Non-loopback listener metadata was tested; actual tailnet access was not exercised.

Frontend checks after resolving context conflicts: build PASS, **24 unit and 24 component tests passed**, lint zero errors with 21 inherited warnings. The previous inbox race fix remains covered. Build retains its large-chunk warning. Browser visual equivalence and human acceptance remain unverified; no production cutover is claimed.

`npm --prefix nawaban/webui run test:proxy` exercises a real Vite server and the real backend HTTP handler with a recording CLI stub. The same-origin browser submission initially returned 403; it now returns 200. Seven foreign/opaque/missing/duplicate origin or host cases are rejected before reaching the backend. The proxy validates the incoming browser origin before rewriting it to the backend origin; the backend boundary remains strict. A direct origin-less loopback CLI request still succeeds.

## Fresh database-copy validation

`python3 scripts/verify_database_copy.py /path/to/board.db` opens the source read-only and uses SQLite backup. The latest captured migrated schema contained **10 tables and 14,146 rows**. Exact SQL definitions, row multisets, integrity and foreign keys remained unchanged across migration/initialization and repetition. No origin column was reintroduced.

A second disposable copy received one fictional CLI task and claim. The real HTTP task-detail endpoint returned its context and claimed status; project-filtered module endpoints returned only the intended task, and an unrelated project was empty. The baseline copy remained byte-for-byte equivalent at the schema/row level; only the separate fixture copy gained the expected task. No live task content, private paths or database file is committed.

## Inherited test inventory

All 33 source Python test scripts map from `tests/<filename>` to `tests/upstream/<filename>`. Their historical filenames remain intact for traceability; executable imports and commands target nawaban.

| Group | Count | Script filenames |
| --- | --- | --- |
| Ownership, lifecycle, and hooks | 11 | `test_branch_gate.py`, `test_claim_check.py`, `test_claim_upstream_gate.py`, `test_guard_bash_tripwire.py`, `test_handoff_completed_gate.py`, `test_merge_gate.py`, `test_workos_db.py`, `test_workos_gate.py`, `test_workos_guard.py`, `test_workos_loader.py`, `test_workos_wrapup.py` |
| Inbox and notifications | 5 | `test_inbox_answer.py`, `test_inbox_budget.py`, `test_inbox_projection.py`, `test_workos_asks.py`, `test_letters.py` |
| Content, projects, and board projections | 8 | `test_cli_modules.py`, `test_field_contract.py`, `test_graph_ego.py`, `test_legacy_detail.py`, `test_origin_gate.py`, `test_project_filter.py`, `test_title_gate.py`, `test_workos_board_view.py` |
| Import and maintenance | 5 | `test_reclaim_stale.py`, `test_recon_target.py`, `test_triage_apply.py`, `test_workos_import.py`, `test_workos_stale.py` |
| Distribution, integration, and skills | 4 | `test_distribution.py`, `test_herdr_watch_debounce.py`, `test_skill_dispatch_table.py`, `test_skill_shelf.py` |

The migration adapts package imports, runtime locations, hook locations, skill names, and temporary fixture paths to the public checkout. Distribution coverage exercises the checkout CLI and built Web assets rather than requiring a separate pip package. Legacy environment-variable and board-path fixtures remain compatibility tests. Tests referencing the removed standalone DAG must follow the updated product scope; module-network behavior remains covered.

Direct pytest now collects main-based scripts through [test_upstream_scripts.py](../tests/test_upstream_scripts.py). [conftest.py](../tests/conftest.py) isolates state and credentials during collection and each test, and supplies subprocess PYTHONPATH. The legacy [runner](../tests/run.py) remains available. Missing optional PyYAML skips only YAML parsing coverage; database, CLI, HTTP and plugin tests still run.

## Reproduction

Build the UI first because HTTP distribution coverage serves the built assets:

```sh
npm --prefix nawaban/webui ci
npm --prefix nawaban/webui run build
npm --prefix nawaban/webui run lint
npm --prefix nawaban/webui test
npm --prefix nawaban/webui run test:components
npm --prefix nawaban/webui run test:proxy
uv run --no-project --python 3.12 --with pytest python -m pytest -q tests
```

For the optional historical YAML path, add `--with pyyaml` and run `python tests/run.py` through uv. CI runs both the dependency-minimal suite and the optional compatibility suite.

Delivery remains an unmerged PR. CI results and visual acceptance must be checked separately; passing local tests does not establish either.
