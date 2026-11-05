# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

A Herdr app mod (gpui-kit JS, `herdr/mods/nawaban-board`), shown as a side panel beside the terminals. Not a browser page.

## Users

- **The owner (董事长).** One person running several coding agents across a few projects (nawaban, agent-center, bzkanbanv2, …). They talk only to the lead agent of each task window and do not run the CLI themselves.
- **Lead agents (总经理).** One per task window. Each pursues a goal, dispatches workers and records progress, decisions and questions on the board through the CLI. They never read the panel.

The panel is for the owner. They open it at two moments (confirmed 2026-11-05):

1. **A glance between things.** Is anything waiting on me, and is anything stuck?
2. **A periodic look at the whole.** Once or twice a day: where each piece of work stands and what got done.

## Product Purpose

nawaban is the issue tracker the agents use. It records tasks and an append-only event log per task: notes, decisions, links and status changes. The panel turns that log into what the owner needs to act on. Success means that within a few seconds the owner knows whether they are needed, and one click takes them to the window where they are needed.

## Positioning

The board is written only by agents and read by a person. The panel does not manage work. It reports on work that agents manage. Its job is to show which agent decisions need the owner, and where.

## Operating Context

- Herdr holds spaces → tabs → panes. Each Claude Code session runs in a terminal and has `HC_TERMINAL_ID` in its environment.
- The panel follows the project of the focused Herdr space. It runs `python3 ~/nawaban/nawaban/cli.py json …` in that folder.
- A task is waiting on the owner when its latest `triage:` note is `triage: needs-info — 等你：<question>`.
- In-progress is derived: an open task held by a session.

## Capabilities and Constraints

- **Read-only.** The panel never writes to the board.
- **Click to go.** Clicking an item should focus the Herdr window or pane of the agent responsible for it (confirmed 2026-11-05). Herdr's terminal list carries no session id, so `claim` records `HC_TERMINAL_ID` in its status event and `json board` returns it as each held task's `terminal` (`docs/adr/0001-claim-records-the-terminal-in-the-event-body.md`).
- **Default scope is the current space's project** (confirmed 2026-11-05). Other projects appear only as a hint of how many items are waiting on the owner there.
- The panel is 420 px wide by default and can be resized from 360 to 720 px. It is toggled with `cmd-shift-j`.
- Keyboard: ↑ and ↓ move, Enter goes to the window, Esc clears the selection.
- It takes its colours from Herdr's `theme()`, in both light and dark.
- UI text is Chinese, with English when the system language is English.
- There is no creator column on tasks, so "which lead made this task" is not recorded.
- Terms: 等你 (waiting on you), 进行中 (in progress), 待认领 (open, unclaimed), 最近完成 (recently done).

## Brand Commitments

- Interfaces avoid the following:
  - an off-white or cream ground;
  - italic accent words in headings;
  - `01 / 02 / 03` numbered labels;
  - monospace used as decoration;
  - pill-shaped buttons;
  - gradients with no purpose.

## Evidence on Hand

- The real board is `~/.nawaban/nawaban.db`. On 2026-11-05 it held:
  - about 6 tasks waiting on the owner;
  - 1 task in progress;
  - 183 open and unclaimed;
  - 33 done in the last 24 hours.
- Questions waiting on the owner are written by agents. They are often long sentences rather than short questions.
- The current panel is in `herdr/mods/nawaban-board/`, with a screenshot at `docs/images/herdr-panel.png`.

## Product Principles

1. **Needed or not.** The first thing the panel answers is whether the owner is needed now.
2. **Show where, not everything.** An item exists to take the owner to the right window. Details live in that window, or in `nawaban show`.
3. **Quiet when nothing is wrong.** Work that moves along normally gets the least space.
4. **Entities only when needed.** Add no concept the board does not already record.
