# Capture validation — NAWABAN-CAPTURE-018

## Scope

Independent worktree based on `0930f1d20b111afa984cd360927f9313250073d5`. Changes add an independent capture queue, CLI lifecycle, same-origin browser creation, and task provenance. No live board schema migration, deployment, or human acceptance is claimed.

## Automated checks

- `uv run --no-project --python 3.12 --with pytest --with pyyaml python -m pytest -q tests`: **420 passed, 9 subtests passed** (before the final reviewer-requested resolution-text validation; its focused regression is recorded below).
- `npm --prefix nawaban/webui run build`: **PASS**; existing bundle-size warning remains.
- `npm --prefix nawaban/webui run lint`: **PASS**, existing component Fast Refresh/effect warnings remain.
- `npm --prefix nawaban/webui test`: **26 passed**.
- `npm --prefix nawaban/webui run test:components`: **61 passed**, including all six capture component tests.
- `npm --prefix nawaban/webui run test:proxy`: **1 passed**, covering both answer and capture through the real Vite proxy.
- `git diff --check`: **PASS**.

The first full runner reported two missing glossary registrations. Both were fixed in `CONTEXT.md`; the complete pytest run above includes the glossary and inherited upstream suite. Default system Python lacked pytest; checks used the declared CI Python 3.12 environment. No failed check was bypassed.

## Migration on a real-board copy

SQLite backup from the requested board into a temporary file; all writes and reader verification used the copy. New migration returned `['captures']`, repeated migration returned `[]`. Exact pre-existing table DDL and every task row compared equal. Only `captures` was added. `board_data` returned five backend columns and `task_detail` read NAWABAN-CAPTURE-018 successfully.

## Browser observation

Safari, through native computer-use controls, served the worktree production build on a random loopback port with a fresh temporary database. Aside was unavailable (daemon unreachable), so it was not the source of browser evidence.

1. Opened the separate Capture navigation item and saved an idea. It appeared immediately; the input cleared. A screenshot was inspected for desktop layout.
2. Converted that capture using the worktree CLI to the pre-existing temporary task DEMO-CAPTURE. Refresh removed it from pending; history showed the target button. Opening that button displayed the task and the original capture ID/text under “来自捕捉”. Escape closed the task dialog.
3. Saved another idea using Tab and Return. CLI discard recorded a reason. Refresh removed it from pending and history displayed the exact reason.
4. Board still displayed **one task**, the original DEMO-CAPTURE, despite two captures. Capture text did not appear in task columns.
5. Switching locale changed the mounted Capture heading, form, search, and history labels to English.

This is agent-driven local browser verification, not human acceptance or live-runtime verification. Mobile viewport layout was not visually verified.

## Independent Claude review

Claude CLI (`claude-fable-5-1`, observed in the returned model usage) reviewed the full diff/new-file packet and then the focused fixes. Both verdicts were **PASS / no blocking findings**. The initial review packet SHA256 was `f34c3ee6319a25258599b4f55b66cd11a04bdf19967025547179100667e5c434`. Review was source-only; the reviewer did not run tests or operate the browser. The primary agent ran the checks above.

- Confirmed and reproduced before repair: JSON NUL/lone-surrogate input closed HTTP connections; URI metacharacters in the DB path selected the wrong file; concurrent pending-poll saves displayed reversed order. Backend reproduction: **9 failed, 2 passed**; ordering reproduction: **1 failed**. After fixes: **135 backend tests passed**, **6 capture component tests passed**.
- Conditional project/identity concerns were disproved by existing `unassigned` mapping and fixed `FOREMAN_OWNER=capture-ui`; new IPv4/IPv6 HTTP scope regression passed.
- `capture list --task` now defaults to all statuses, so reverse lookup works directly.
- The second review recommended applying the same text validation to CLI resolution material. The exact one-line validation was adopted, with regression assertions that rejection preserves pending state. This final narrow addition follows the reviewer recommendation; the source-only PASS preceded that addition.
- Unsaved draft retention across project/view changes is not implemented and is documented. No saved capture is deleted by navigation. No hypothetical stdout fallback or unrelated existing-table migration changes were added.

The first bare Claude invocation could not access login credentials and returned “Not logged in”; the normal authenticated CLI produced the two review verdicts. Neither a failed invocation nor a model recommendation to merge was treated as merge authorization.

Final narrow resolution-text regression: `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests/test_captures.py tests/test_http_write_security.py` — **139 passed**.
