# BoardUI source and NAWABAN boundary

The frontend uses BoardUI source components installed through the official `boardui` CLI. Component Figma node references are retained; semantic themes and typography live in `src/styles`. The source-owned wrappers use Base UI interaction primitives. Calendars use DayPicker with `@internationalized/date` values, and tables use semantic HTML.

## Component provenance

| Surface | BoardUI sources |
| --- | --- |
| Navigation and filters | NavItem, ThemeToggle, Input, Select, DateRangePicker, Button |
| Cards, module nodes and tags | SettingsCard, Button, Chip, Badge, StatusDot |
| List and detail properties | Table, SettingsRow, SettingsValueField |
| Detail and answers | BoardUI dialog surface recipe, Base UI Dialog, CloseButton, RadioCard, Textarea |
| Notices and long text | Notification, Base UI Toast, Tooltip |

Business sections, Markdown, layout grids, module statistics and SVG dependency wires compose these sources. Upstream component metadata remains intact. The isolated `interaction-fixture.html` exercises the production `NawabanDialog` and base controls without backend calls and is excluded from the production entry.

## Data and interaction contracts

- Project selection scopes board, modules and inbox requests and is retained in the URL and local preference. All projects includes unassigned cards. Switching projects removes the previous inbox controls and drafts immediately; late reads and answer-triggered refreshes cannot repopulate an obsolete project. Overlapping inbox refreshes apply only the latest request.
- Board cards and module nodes share `TaskCard`: a title zone over a footer zone. The footer shows the module as plain text and reserves chips for state. A state label appears only when it tells a card apart from its column neighbours: the acceptance column omits its implied release wait. The last-activity date is pinned to the footer's right edge and changes colour once started work has been idle for three and seven days; backlog and finished cards keep a neutral date. Cards without a module show a muted placeholder. Task IDs stay in the detail drawer and list view. Window activity controls a status dot in the card's top-right corner; a pending decision is a labelled button; a missing signal renders nothing.
- The module graph preserves dependency layers, independent nodes, cross-module edges, search dimming and focus traversal. Module selection updates the URL and survives reload.
- Read polling waits until the preceding request settles and discards responses after a view/filter change. Detail navigation keeps one drawer with Back history and ignores obsolete detail responses.
- The only mutation is `POST /api/answer` with `{ask_id, verdict, reject}`. Unknown outcomes lock resubmission pending refresh; no automatic write retries occur. Authorization records a decision and does not execute it.

## Context and reading surfaces

Task context supports Markdown headings, lists, links and blockquotes. Local task links navigate within the drawer. Explicit formatting annotations use `CONTEXT_LAYOUT_QUESTION` in `src/lib/nawaban-model.ts`; the latest matching decision supplies presentation, while the original context and decision history remain available. Rendering never rewrites stored task data.

`src/styles/nawaban-typography.css` owns the shared reading hierarchy. Long titles, module names, tags and reference values retain complete text and destinations; `OverflowText` adds BoardUI tooltips when their rendered text overflows. Full task details remain available by opening a card or row.

## Verification boundary

Run the commands in [README.md](README.md). Node tests cover data mapping, graph relationships, navigation, source provenance, date behavior, polling and answer outcomes. Component tests cover control interaction, dialog dismissal, focus and selection. These fixtures do not establish live inbox approval or full mobile/keyboard acceptance; those require separate integration checks against a database copy.
