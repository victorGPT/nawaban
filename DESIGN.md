---
name: nawaban Herdr panel
description: Which windows are waiting on you, and what the others are doing.
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
  row: "38px"
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
  status-badge:
    rounded: "{rounded.sm}"
    padding: "1px 6px"
    typography: "{typography.label}"
---

# Design System: nawaban Herdr panel

## Overview

The panel is a Herdr mod at the side of the terminals, 420 px wide by default. It shows one project, the one of the focused space, and lists its windows. It answers two questions, in this order:

1. Is any window waiting on me?
2. What are the others doing?

The approved structure is mix B+C (2026-11-05). The sketches are in `.impeccable/mocks/decision/mix-{dark,light}.html` and at https://claude.ai/artifact/EJoBooRQwxnLNUJDpqyKsP.

From top to bottom:

1. **Header.** The project name. On the right: how many windows, and how many items are waiting in other projects.
2. **Waiting.** A large headline, "N 个窗口在等你", then one card per waiting window.
3. **Table.** Every other window, in four columns: 窗口 | 在干 | 状态 | 多久.
4. **Idle.** Idle windows collapse into one last row, with their count and names.

When nothing is waiting, the headline and the cards disappear, and the table moves to the top.

## Colors

- **Theme.** All colours come from Herdr's `theme()`. The panel follows Herdr's light and dark themes and defines no colours of its own.
- **Status colours.** These use Herdr's own status tokens, so the panel and the Herdr sidebar mean the same thing by the same colour:
  - `blocked` (amber): waiting on you, or stopped.
  - `working` (blue): in progress.
  - `done`: finished.
  - `idle` (grey): nothing to show.
- **Amber is reserved.** Amber is the only loud colour, and it appears only on windows that need the owner. Nothing decorative is amber.

## Typography

- **Faces.** Herdr's system UI face only.
- **Scale.** Four sizes:
  - 20 px, the headline only;
  - 13.5 px, window names and questions;
  - 12.5 px, table rows;
  - 11 px, column heads and badges.
- **Numbers.** Durations and counts use tabular figures.

## Layout

- **Spacing.**
  - 16 px side edge.
  - Cards sit 12 px in from the panel edge, with 8 px between them.
  - Table rows are 38 px high.
- **Table columns.** 窗口 is 150 px. 状态 and 多久 are fixed. 在干 takes the rest and is cut off with an ellipsis.
- **Row order.** 停了 → 完成 (not yet looked at) → 在干. Idle is always the last row.
- **Width.** From 360 to 720 px. Extra width goes to 在干. Below 400 px, the 多久 column is dropped.

## Shapes

- **Radii.** Cards 8 px, buttons 6 px, badges 4 px.
- **No pills.** Nothing is pill-shaped.
- **Lines.** Table rows are separated by 1 px `border` lines. Nothing has a shadow.

## Components

- **Wait card.** Line 1: the window name on the left, "等了 1 小时" in amber on the right. Then the question it is asking, at most two lines. Then what it is working on, dim, on one line, with the "去窗口 →" button on the right. Clicking the card or the button focuses that window's terminal (`agent.focus {terminal}`).
- **Status badge.** One of 停了, 完成, 在干. Its text is in the status colour, on that colour at low opacity.
- **Row.** Clicking a row focuses the window, the same as a card. ↑ and ↓ move through cards and rows together, and Enter goes to the selected one.

## Do's and Don'ts

### Do

- Make whether the owner is needed readable without reading any text: the headline and amber cards are present, or absent.
- Show what an agent wrote, cut to fit, instead of rewording it.
- Leave out any state the board and Herdr do not record.

### Don't

- No cream or off-white ground.
- No italic accent words.
- No `01 / 02 / 03` labels.
- No monospace as decoration.
- No pill buttons.
- No gradients.
- No amber except for "needs you".
- No colours of the panel's own; every colour comes from the Herdr theme.
