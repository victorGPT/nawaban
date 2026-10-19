# NAWABAN webui

NAWABAN uses shadcn/ui (Base UI registry) source components with React, TypeScript, Vite and Tailwind CSS. The project selector, task board/list and task detail read the backend's read-only APIs. Every write goes through the CLI.

## Build and run

From the repository root:

```bash
cd nawaban/webui
npm ci
npm run build
bash ../board-up.sh
```

`board_view.py` serves `webui/dist` directly and answers only reads (`/api/projects`, `/api/board`, `/api/task`). `/` and `/?task=TASK-ID` load the same application: the board, with a task's detail opened over it. The project selector retains `project` in the URL and local preference. Cards without a project remain accessible under all projects.

A frontend rebuild takes effect on the next page request. Backend changes require restarting the listener; `board-up.sh` does not replace a running process. Install the frontend and backend together.

`dist/` is committed so that installing nawaban needs no Node. After changing the frontend, run `npm run build` and commit `dist/` with the change; CI rebuilds it and fails when the committed copy differs.

## Language

The sidebar switches between English and Simplified Chinese. The saved `nawaban.locale` preference wins on reload; without a valid saved preference, the browser language selects Chinese for `zh` and English otherwise. Switching still works when browser storage is unavailable. UI labels and dates follow the selected language; task content, API identifiers and stored lifecycle values retain their original meaning. The board has three lanes: Unassigned, In progress (derived: a session holds an open task) and recently Done; cancelled tasks are not on the board. The 238px sidebar and 1000px detail sheet use the same light canvas and surface tokens; details stack below 800px. Dark mode remains available.

English and Chinese messages live in `src/i18n/en.json` and `src/i18n/zh-CN.json`. English terms are registered in the repository's `GLOSSARY.md` glossary. `tests/test_glossary.py` checks matching keys and placeholders, glossary coverage, and the absence of hardcoded Chinese in frontend TypeScript.

## Development

```bash
npm run dev -- --host 127.0.0.1 --port 8827 --strictPort
```

Vite proxies `/api` to port 8813 by default. `NAWABAN_API_URL` selects the backend. Final integration checks must open the Python-served build because Vite does not exercise backend page routing.

## Verification and contracts

```bash
npm run build
npm run lint
npm test
npm run test:components
npm run test:proxy
```

All business data comes from the backend's read-only APIs; the page never writes. Component tests use isolated fixtures and do not touch the live database.

See [UI.md](UI.md) for component provenance and UI contracts.
