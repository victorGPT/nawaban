# The web page is Solid 2 on UI SDK, built by Vite and served by the board process

Status: accepted (11-24, orchestrator on delegation; the decision-maker can overturn). The stack (SolidJS 2 + Vercel UI SDK) is the decision-maker's (NAWABAN-WEB, 11-24); the rest are the orchestrator's defaults and can be overturned.

The web page (NAWABAN-WEB) gives someone without Herdr the panel's views of their own board: 待决, OKR, 任务, 收件箱, and a task's detail. It runs on each person's machine and reads the board `nawaban serve` already runs on `127.0.0.1:4100`. We write it in SolidJS 2 (`solid-js` 2.0.3, `@solidjs/web` 2.0.3) with Vercel's UI SDK (`@ui-sdk/solid` and `@ui-sdk/core`, both pinned at `0.1.0-beta.17` since 11-25, first at `0.1.0-beta.13`), build it with Vite 8 and `@solidjs/vite-plugin` 3, and serve the built files and a read-only view API from the same process that serves the board. The browser never holds the board's token. An answer or an inbox item written on the page lands on the board as a message the orchestrator reads and acts on; the page never records a decision as made.

`web/` holds the spike that settles the stack: a Solid 2 page that renders a board's tasks in UI SDK's `Listbox`, built and typechecked by `pnpm check`.

## UI SDK as found on 11-24

- It is [vercel-labs/ui](https://github.com/vercel-labs/ui) ([docs](https://ui-sdk.dev/docs)): headless behaviors (focus, keyboard, selection, popups, dismissal, ARIA) in `@ui-sdk/core`, with adapters for React, Vue, Svelte, Solid and Web Components, and ready parts such as `@ui-sdk/solid/listbox`. Apache-2.0.
- It is beta only. First published 11-12; npm `latest` is `0.1.0-beta.13`, `beta` is `0.1.0-beta.16`, and fifteen betas shipped in eleven days. The README says APIs may change before general availability.
- `@ui-sdk/solid` peers on `solid-js ^2.0.0` and `@solidjs/web ^2.0.0`. The spike builds and renders against `solid-js` 2.0.3: the `Listbox` comes out with `role="listbox"`, `role="option"`, `aria-selected` and roving `tabindex`.

## Considered Options

### Front end

- **Solid 2 + `@ui-sdk/solid` (chosen)**: the decision-maker's call, and it runs.
- **React + `@ui-sdk/react`**: rejected, the decision-maker named Solid.
- **The inspector's page (`@vercel/board/inspect`)**: rejected as the page, a prebuilt React bundle of the board's generic views (channels, threads, tasks) that knows no 待决 card, OKR row or 收件箱, and can't be restyled. Kept as a tool: `vb inspect --url http://127.0.0.1:4100/api/board` still opens any thread raw.
- **A Solid component library other than UI SDK**: rejected, the decision-maker named UI SDK, and it works on Solid 2.

### Build

- **Vite 8 + `@solidjs/vite-plugin` 3.0.1 (chosen)**: the plugin's stable line peers on `solid-js ^2` and `vite ^8 || ^9`; `@ui-sdk/solid` ships its Solid parts as `.jsx` under a `solid` export condition, so they need Solid's compiler.
- **`vite-plugin-solid` 2.x**: rejected, it peers on `solid-js ^1.7`.
- **SolidStart**: rejected, it brings a server of its own and the board process is already the server.
- **No build step**: rejected, UI SDK's Solid parts are uncompiled JSX.

### Who serves the page

- **The board process, same port (chosen)**: `nawaban serve` adds `GET /` and the built files, and `/api/nawaban/*` beside the board's `/api/board`. One process, one port, one launchd agent; the view code already runs in this process's language against a `board()` handle.
- **A second local server**: rejected, a second port and a second thing to keep running for the same data.
- **`vb serve`**: rejected, it runs a board of its own instead of serving nawaban's, without its schemas and middleware.
- **The Vite dev server with a proxy**: only for development and the spike; it needs Vite at run time.

The built files are not committed: the install builds them (`pnpm --dir web install --frozen-lockfile && pnpm --dir web build`), and `nawaban serve` without them still serves the board and answers `/` with how to build. Committing `web/dist` was rejected: every change ships twice and the two drift.

### Reads

- **A view API in the board process (chosen)**: `GET /api/nawaban/board?project=`, `/projects`, `/task/:key`, `/okr?repo=` (or `?project=`, found through the board's `repos.json`, since the page knows the project and not the repository), each the JSON `nawaban json …` prints (`views.ts`, `okr.ts`), so the page and the Herdr panel draw one contract. `GET /api/nawaban/changes` is a server-sent stream that says "something changed" whenever the board's event feed moves (`team.events()` in the process), and the page reads its views again.
- **The page holds a `board()` handle, as the inspector's does**: rejected, the panel's views (`boardData` walks every task's history) would be rebuilt in the browser, and the page would need a credential the board accepts.
- **The page calls `/api/board` directly**: rejected, that puts the board's token, which can write anything, in the browser.

### Who may call it

The board token stays in the process. `/api/nawaban/*` answers only:

- a request whose `Host` is `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise, against DNS rebinding), with no `X-Forwarded-*`, `Forwarded` or `X-Real-IP` header (421);
- carrying `Authorization: Bearer <web token>`, a second secret in `<board dir>/web-token` written the way `token` is (401 without it);
- and for a write, an `Origin` equal to the page's own (403 otherwise).

`nawaban web` opens `http://127.0.0.1:<port>/#k=<web token>`; the page moves the token into `sessionStorage` and drops the fragment with `history.replaceState`, so it never reaches a server log or another tab. Rejected: no token at all (any local process or page that gets past the `Host` check reads the board), the board's own token in the page (it can do everything, not just what the page does), a cookie (CSRF to guard as well, for one local user).

### Writes (for NAWABAN-WEB-04)

- **An answer to a 待决 (chosen)**: a reply on the task's thread carrying a new block `nawaban-web-answer@1` `{ option?, words }`, posted as the local person. It does not lift the hold. The orchestrator's Stop hook (`cli.ts inbox`) already reads every task held `awaiting_approval`; it also says which of them the page answered (`待决 N 件，网页已答 M 件`), and the orchestrator checks the answer and records it with `event --kind resolve`, as it does after a Herdr answer.
- **The page writes `nawaban-resolve@1`**: rejected, `resolve` lifts the hold, so the page itself would record the decision as made, which NAWABAN-WEB rules out.
- **The page types into the orchestrator's terminal, as the panel does**: rejected, that is Herdr's `hc send`, which a person without Herdr doesn't have.
- **An inbox item (chosen)**: a root message in channel `inbox/<project>` (as OKR uses `okr/<project>`) whose first line is the words and which carries a `nawaban-inbox@1` `{ words }` block, with the label `inbox=open`. The same hook counts the open ones; the orchestrator makes one a task in the project (`nawaban create <KEY> --project <p>`) and then sets `inbox=done task=<KEY>` (`--if inbox=open`), or makes a command of it, or drops it, and sets `inbox=done`. Rejected: browser storage (lost with the browser, unseen by the orchestrator), a task per item (it would sit in 待办 before anyone decided it is work), `POST /tasks` with `re` on the item (tried 11-24: the task stays in channel `inbox/<project>` with no `key`, so the project's `json board`, `index`, `list` and the panel never see it, and `json projects` lists `inbox/<project>` as a project).

## Consequences

- UI SDK is beta and ships almost daily. Both packages are pinned exactly and move together on purpose; a breaking beta is a pin we don't take yet.
- On 11-25 the pin moved from `0.1.0-beta.13` to `0.1.0-beta.17` (npm `latest` that day), the decision-maker's call for NAWABAN-HOME-A: the approved canvas is built on spec-01, whose React parts run on `@ui-sdk/react` `0.1.0-beta.17`, and its skin styles the `data-*` state attributes UI SDK emits, so the Solid page takes the same release to emit the same markup. `pnpm check` (typecheck, 65 tests, build) passed on beta.17 with no code change.
- The page needs Node and pnpm at install to build, the same as the board.
- `web/` has its own `package.json` and lockfile, checked in CI by `pnpm check` (typecheck, vitest and build).
- The page imports the Herdr panel's `logic.js` for what both draw alike (a task group's fold and its 3-row cap, time labels, words), so the two can't drift. Without Herdr's window states, a held task reads 停滞 when it is asking, or quiet for 24 hours (the orchestrator's `STALLED_AFTER_QUIET_FOR`).
- Since NAWABAN-WEB-04, `board/src/schemas.ts` registers `nawaban-web-answer@1` and `nawaban-inbox@1`, and `board/src/page.ts` holds their readers (`webAnswers`, `openInboxItems`) and writers' text (`webAnswerText`, `inboxItemText`) for the page to reuse. An answer counts only when it comes after the card or `needs-info` note that raised the current hold.
- Since NAWABAN-WEB-07, the inbox is the first write the page makes: `GET /api/nawaban/inbox?project=` lists the project's items, open ones newest first, then the ones the orchestrator set `inbox=done` (with `task` when it made one a task); `POST` with `{ words }` keeps one as `inboxItemText` with `inbox=open`; `DELETE /api/nawaban/inbox/<id>` deletes a root in an `inbox/` channel carrying `nawaban-inbox@1`, and nothing else. Every other write still answers 405.
- Since NAWABAN-WEB-03, the 待决 tab answers a card with `POST /api/nawaban/answer/<key>` `{ ask, option?, words }`, where `ask` is the id of the card it answers (`pending.ask` in `json board`). The process takes it only while the task is held `awaiting_approval` and that card is still the latest; otherwise it answers 409, and the person reads the new card first. Since NAWABAN-HOME-A it also takes an answer to a task held `needs_input` (等你, a question without a card), where `ask` is the question itself (`waiting` in `json board`, the hold's reason), so a question asked again in other words gets 409 the same way. It posts `{ option?, words }` with `webAnswerText` as the local person (the board token through the board's own handler), with `after` set to the thread's newest message, so a card raised between the check and the write still gets 409. `GET /api/nawaban/answers?project=` (`webAnswers`) says which cards the page answered; the tab lists only complete cards and marks a card 已交编排者 from it, not from its own memory.
- Since NAWABAN-HOME-A the page is four pages, 待决 / 任务 / OKR / 随手记 (the 收件箱 page renamed), and opens on 待决, which lists every project's held tickets and OKR waits. It draws with the hardware skin of spec-01 (MIT, Shu Ding): `web/src/hardware/` keeps only the rules the page's markup matches, with the LICENSE, and every part of a page is a component in `web/src/components/` that emits the skin's `data-kit` markup. Tailwind and the shadcn tokens are gone.
- Without Herdr there is no terminal to label: `/nawaban:orchestrator` records the Claude Code session as the project's orchestrator in `<board dir>/orchestrator/<project>` (one per project, the last declared), and the hooks recognise it by `session_id`. A Stop hook's line reaches only the person, so the details reach the orchestrator's model on each prompt through a UserPromptSubmit hook (`hooks/page-writes.sh`, `nawaban page --project`), and in `index`. With Herdr, the terminal label and `hc send` stay as they were.
