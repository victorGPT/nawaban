---
name: nawaban Herdr panel
description: Which windows are waiting on you, and what each leader and its workers are doing.
colors:
  # Every value is read at runtime from Herdr's theme() under the same key.
  # The hex values are herdr-t3 (dark), for reference only.
  canvas: "#141418"
  surface: "#232328"
  border: "#353539"
  foreground: "#ececf0"
  muted: "#a9a9b4"
  dim: "#83838f"
  working: "#6b93ff"
  blocked: "#f0a33a"
  done: "#ececf0"
  idle: "#83838f"
typography:
  headline:
    fontFamily: "system UI (Herdr default)"
    fontSize: "20px"
    fontWeight: 600
  title:
    fontSize: "13.5px"
    fontWeight: 600
  body:
    fontSize: "13.5px"
    lineHeight: 1.5
  row:
    fontSize: "12.5px"
  note:
    fontSize: "12px"
  label:
    fontSize: "11px"
    fontWeight: 600
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
spacing:
  edge: "16px"
  card-gap: "8px"
  item: "30px"
components:
  wait-card:
    backgroundColor: "blocked at 15% over canvas"
    rounded: "{rounded.lg}"
    padding: "12px"
  wait-card-button:
    backgroundColor: "{colors.blocked}"
    textColor: "{colors.canvas}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
  item-dot:
    size: "8px, the current one 12px"
    rail: "2px, {colors.border}; {colors.muted} beside done items"
  progress-segment:
    size: "14px x 3px"
    rounded: "1px"
    gap: "3px"
---

# Design System: nawaban Herdr panel

## Overview

The panel is a Herdr mod at the side of the terminals, 420 px wide by default. It shows one project, the one of the focused space. It answers three questions, in this order:

1. Is any window waiting on me?
2. What is each leader, and each worker it dispatched, doing, in the order the work came in?
3. What was last decided about it?

The approved structure is the line view (2026-11-06), which replaces the window table of mix B+C. The sketch is `.impeccable/mocks/decision/rail-dark.html`, published at https://claude.ai/artifact/XMsBBXzSZE74ANhUVKwL3A.

- **The unit is the task, not the worker.** A worker is temporary; its task stays on the board with its blockers and its notes. A worker shows only as the state of the task it holds, and as the note it last wrote.
- **Groups are leaders.** A task's leader is the author of its latest `dispatch:` note, else the session holding it (GLOSSARY: Leader).
- **Numbers are arrival order, not a plan.** Work arrives in no fixed order, so a leader's items are numbered by when each was first claimed. A task added today comes last. Only inside a spec does order come from blocked-by.

From top to bottom:

1. **Header.** The project name. On the right: how many windows, and how many items are waiting in other projects.
2. **Waiting.** A large headline, "N 个窗口在等你", then one card per waiting window. Unchanged from mix B+C.
3. **Leaders.** One group per leader with an open task: its own tasks and the ones it dispatched, numbered by arrival. A spec is one item with its own progress segments. Done items stay, ticked, for 24 hours. A 1 px `border` line separates groups.
4. **没认领.** Every window of the space that is neither a card nor holding a task collapses into one last row, with its count and names, the Herdr state after a working or done one: "没认领 3 · 部署（在干）、闲聊、13（完成）". A window working with no task still shows.

When nothing is waiting, the headline and the cards disappear, and the leaders move to the top.

## Colors

- **Theme.** All colours come from Herdr's `theme()`. The panel follows Herdr's light and dark themes and defines no colours of its own.
- **Status colours.** These use Herdr's own status tokens, so the panel and the Herdr sidebar mean the same thing by the same colour:
  - `blocked` (amber): waiting on you, or stopped.
  - `working` (blue): an item someone is on now.
  - `muted`: done items and the rail beside them.
  - `dim` and `border`: items not started, and the rail ahead.
- **Amber is reserved.** Amber is the only loud colour, and it appears only on windows that need the owner. Nothing decorative is amber.

## Typography

- **Faces.** Herdr's system UI face only.
- **Scale.** Five sizes:
  - 20 px, the headline only;
  - 13.5 px, leader names, window names and questions;
  - 12.5 px, item titles;
  - 12 px, the decision line and the note under a current item;
  - 11 px, numbers, states and counts.
- **Numbers.** Durations and counts use tabular figures where the platform allows (gpui-kit has no font-feature setting as of 2026-11-06).

## Layout

- **Spacing.**
  - 16 px side edge.
  - Cards sit 12 px in from the panel edge, with 8 px between them.
  - Items are 30 px high; a current one grows by its note.
- **Item grid.** An 18 px rail column, the number and title, a spec's segments and done/total, and the state on the right. Who does it (自己 or worker) opens the note line, not a column. The title is cut off with an ellipsis; extra width goes to it.
- **Order.** Groups: a leader with a stopped item first, then the rest by when they last moved. Items: by when each was first claimed; not yet claimed ones after, by creation. Inside a spec: blocked-by order, ties by the board's order.
- **Width.** From 360 to 720 px. Below 400 px, the progress segments are dropped.

## Shapes

- **Radii.** Cards 8 px, buttons 6 px, progress segments 1 px.
- **No pills.** Nothing is pill-shaped.
- **Lines.** Groups are separated by 1 px `border` lines. Nothing has a shadow.

## Motion

- **One pulse.** The inner dot of each current item breathes (`loop("opacity", …)`, about 1.6 s, between 1 and 0.25). It is the only thing that moves, and it runs natively, only while drawn.
- **No redraw timers.** Everything else changes only when the data does.

## Components

- **Wait card.** Line 1: the window name on the left, "等了 1 小时" in amber on the right. Then the question it is asking, at most two lines. Then the task id, muted, on one line, with the "去窗口 →" button on the right. Clicking the card or the button focuses that window's terminal (`agent.focus {terminal}`).
- **Leader header.** The leader's window name, semibold, on the left. On the right, dim: "自己 3 · 派出 2".
- **Decision line.** Under the header, dim, one line: the date of the latest decision recorded on any of the leader's open items, "定：", and the first line of its verdict. Left out when there is none.
- **Item.** A dot on the rail, the number (11 px, dim), the task or spec title, and its state on the right. A spec shows its progress segments (one per ticket: `muted` done, `working` held, `border` not started) and "done/total" before the state. A spec whose tickets nobody holds, held itself, is current or stopped on its own note. Durations read as on the cards ("40 分钟", "2 小时"; en "40m", "2h").
  - done: filled `muted` dot, "完成 09:10" ("完成 昨天 18:40", "完成 11-04 18:40");
  - current (held): a `working` ring with a breathing inner dot, "在干 40 分钟";
  - stopped (held, its window gone or idle): a `blocked` ring, "停了 2 小时";
  - not started: a hollow `dim` dot, "还没动".
- **Note.** Under a current or stopped item only: who is on it, 自己 or worker, then the latest note it wrote ("自己 · verify：3814 个测试通过"), at most two lines, skipping `coord:` notes, which are bookkeeping. "去窗口 →" sits at its right, in `foreground`, when the window is still there. A stopped item whose window is gone says so and has no button. Resting the pointer on the item opens a HoverCard with the whole note.
- **Row behaviour.** Clicking an item with a window focuses it, the same as a card. ↑ and ↓ move through cards and items together, and Enter goes to the selected one.

## Do's and Don'ts

### Do

- Make whether the owner is needed readable without reading any text: the headline and amber cards are present, or absent.
- Show what an agent wrote, cut to fit, instead of rewording it.
- Leave out any state the board and Herdr do not record.

### Don't

- No cream or off-white ground.
- No italic accent words.
- No `01 / 02 / 03` labels. Item numbers are plain "1 2 3" in dim 11 px, part of the content.
- No monospace as decoration.
- No pill buttons.
- No gradients.
- No amber except for "needs you".
- No colours of the panel's own; every colour comes from the Herdr theme.
- No motion other than the current items' pulse.
