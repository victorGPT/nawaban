---
name: nawaban Herdr panel
description: Which windows are waiting on you, and how far each goal has got.
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
  station: "30px"
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
  station:
    size: "8px, the current one 12px"
    rail: "2px, {colors.border}; {colors.muted} beside done stations"
  progress-segment:
    size: "14px x 3px"
    rounded: "1px"
    gap: "3px"
---

# Design System: nawaban Herdr panel

## Overview

The panel is a Herdr mod at the side of the terminals, 420 px wide by default. It shows one project, the one of the focused space. It answers three questions, in this order:

1. Is any window waiting on me?
2. How far has each goal got, step by step?
3. What was last decided about it?

The approved structure is the line view (2026-11-06), which replaces the window table of mix B+C. The sketch is `.impeccable/mocks/decision/rail-dark.html`, published at https://claude.ai/artifact/XMsBBXzSZE74ANhUVKwL3A.

The unit is the task, not the worker. A worker is temporary; its task stays on the board with its order, its blockers and its notes. A worker shows only as the state of the task it holds, and as the note it last wrote.

From top to bottom:

1. **Header.** The project name. On the right: how many windows, and how many items are waiting in other projects.
2. **Waiting.** A large headline, "N 个窗口在等你", then one card per waiting window. Unchanged from mix B+C.
3. **Goals.** One group per goal that someone is working on: a spec with its tickets, or a single task with no spec. A 1 px `border` line separates groups.
4. **Idle.** Windows holding no task collapse into one last row, with their count and names.

When nothing is waiting, the headline and the cards disappear, and the goals move to the top.

## Colors

- **Theme.** All colours come from Herdr's `theme()`. The panel follows Herdr's light and dark themes and defines no colours of its own.
- **Status colours.** These use Herdr's own status tokens, so the panel and the Herdr sidebar mean the same thing by the same colour:
  - `blocked` (amber): waiting on you, or stopped.
  - `working` (blue): the station a worker is on now.
  - `muted`: done stations and the rail beside them.
  - `dim` and `border`: stations not started, and the rail ahead.
- **Amber is reserved.** Amber is the only loud colour, and it appears only on windows that need the owner. Nothing decorative is amber.

## Typography

- **Faces.** Herdr's system UI face only.
- **Scale.** Five sizes:
  - 20 px, the headline only;
  - 13.5 px, goal titles, window names and questions;
  - 12.5 px, station titles;
  - 12 px, the decision line and the note under the current station;
  - 11 px, step numbers, states and counts.
- **Numbers.** Durations and counts use tabular figures where the platform allows (gpui-kit has no font-feature setting as of 2026-11-06).

## Layout

- **Spacing.**
  - 16 px side edge.
  - Cards sit 12 px in from the panel edge, with 8 px between them.
  - Stations are 30 px high; the current one grows by its note.
- **Station grid.** An 18 px rail column, the title, and the state on the right. The title is cut off with an ellipsis; extra width goes to it.
- **Order.** Groups: a goal with a stopped station first, then the rest by when they last moved. Stations: in blocked-by order, so a ticket comes after every ticket it waits for; ties keep the board's order.
- **Width.** From 360 to 720 px. Below 400 px, the progress segments give way to the count alone.

## Shapes

- **Radii.** Cards 8 px, buttons 6 px, progress segments 1 px.
- **No pills.** Nothing is pill-shaped.
- **Lines.** Groups are separated by 1 px `border` lines. Nothing has a shadow.

## Motion

- **One pulse.** The inner dot of the current station breathes (`loop("opacity", …)`, about 1.6 s, between 1 and 0.25). It is the only thing that moves, and it runs natively, only while drawn.
- **No redraw timers.** Everything else changes only when the data does.

## Components

- **Wait card.** Line 1: the window name on the left, "等了 1 小时" in amber on the right. Then the question it is asking, at most two lines. Then the task id, muted, on one line, with the "去窗口 →" button on the right. Clicking the card or the button focuses that window's terminal (`agent.focus {terminal}`).
- **Goal header.** The goal's title, semibold, on the left. On the right, one progress segment per ticket (`muted` done, `working` held, `border` not started) and "done/total". A single task shows "单个任务" there instead.
- **Decision line.** Under the header, dim, one line: the date the goal's latest decision was recorded, "定：", and the first line of its verdict. Left out when the goal has no decision.
- **Station.** A dot on the rail, the step number (11 px, dim), the ticket title, and its state on the right:
  - done: filled `muted` dot, "完成";
  - current (held): a `working` ring with a breathing inner dot, "在干 12 分";
  - stopped (held, its window gone or idle): a `blocked` ring, "停了";
  - not started: a hollow `dim` dot, "等 2、3" naming the steps it waits for, or "可开始" when it waits for none.
- **Note.** Under a current or stopped station only: the latest note its worker wrote, at most two lines, skipping `coord:` notes, which are bookkeeping. "去窗口 →" sits at its right, in `foreground`. Resting the pointer on the station opens a HoverCard with the whole note.
- **Row behaviour.** Clicking a station with a window focuses it, the same as a card. ↑ and ↓ move through cards and stations together, and Enter goes to the selected one.

## Do's and Don'ts

### Do

- Make whether the owner is needed readable without reading any text: the headline and amber cards are present, or absent.
- Show what an agent wrote, cut to fit, instead of rewording it.
- Leave out any state the board and Herdr do not record.

### Don't

- No cream or off-white ground.
- No italic accent words.
- No `01 / 02 / 03` labels. Step numbers are plain "1 2 3" in dim 11 px, part of the content.
- No monospace as decoration.
- No pill buttons.
- No gradients.
- No amber except for "needs you".
- No colours of the panel's own; every colour comes from the Herdr theme.
- No motion other than the current station's pulse.
