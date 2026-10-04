# NAWABAN webui

NAWABAN uses shadcn/ui (Base UI registry) source components with React, TypeScript, Vite and Tailwind CSS. The project selector, task board/list, module DAG, task detail and inbox read the backend APIs. Task creation remains a CLI operation.

## Build and run

From the repository root:

```bash
cd nawaban/webui
npm ci
npm run build
bash ../board-up.sh
```

`board_view.py` serves `webui/dist` directly. `/`, `/?view=board`, `/?view=modules`, `/?view=inbox` and `/?task=TASK-ID` load the same application. Module deep links retain `epic`; the project selector retains `project` in the URL and local preference. Cards without a project remain accessible under all projects.

A frontend rebuild takes effect on the next page request. Backend changes require restarting the listener; `board-up.sh` does not replace a running process. Install the frontend and backend together.

The explicit `/?view=legacy` board remains separate. Missing builds retain the embedded pages. The module view includes the dependency graph.

## Language

The sidebar switches between English and Simplified Chinese. The saved `nawaban.locale` preference wins on reload; without a valid saved preference, the browser language selects Chinese for `zh` and English otherwise. Switching still works when browser storage is unavailable. UI labels and dates follow the selected language; task content, API identifiers and stored lifecycle values retain their original meaning. The four visual board lanes match the reference-kanban prototype: Assigned and In progress share a lane, while each task keeps its backend status and assigned cards display an explicit label. List mode and task details retain module names. The 238px sidebar and 1000px detail sheet use the same light canvas and surface tokens; details stack below 800px. Dark mode remains available.

English and Chinese messages live in `src/i18n/en.json` and `src/i18n/zh-CN.json`. English terms are registered in the repository's `CONTEXT.md` glossary. `tests/test_glossary.py` checks matching keys and placeholders, glossary coverage, and the absence of hardcoded Chinese in frontend TypeScript.

## Development

```bash
npm run dev -- --host 127.0.0.1 --port 8827 --strictPort
```

Vite proxies `/api` to port 8813 by default. `NAWABAN_API_URL` selects the backend; `NAWABAN_MODULES_API_TARGET` can override only the module endpoint. Final integration checks must open the Python-served build because Vite does not exercise backend page routing.

The dev proxy forwards inbox answers only after validating that the browser Origin exactly matches its original HTTP Host. Missing, null, foreign or cross-site origins are rejected before forwarding; CLI clients without Origin must use the backend loopback address directly. Production write checks remain in the backend.

## Verification and contracts

```bash
npm run build
npm run lint
npm test
npm run test:components
npm run test:proxy
```

All business data comes from backend APIs. The only write is `POST /api/answer`; backend permissions, compare-and-set behavior and CLI gates remain authoritative. Unknown submission outcomes are not retried automatically. Component tests use isolated fixtures and do not write the live database.

See [UI.md](UI.md) for component provenance and UI contracts.
