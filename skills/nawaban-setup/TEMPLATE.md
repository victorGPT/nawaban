<!-- Historical Markdown workflow reference; current tasks use nawaban DB. -->
---
task_id: CORE-001
status: open            # open → claimed → in_progress → staging-verified → done · one field is not the whole state: read it with pr: (open + pr = code in a PR awaiting merge) and waiting_on: (verified + observe = path verified, effect still being observed)
outcome:                # optional flag, not a status · for abandoned tasks: canceled / superseded · set when moving to done/, with the reason in notes
epic:                   # optional · grouping label for a large requirement (when one plan splits into ≥3 tasks, all carry the same epic) · the board groups by it
owner: window-1         # stable short label, written at claim (NAWABAN_OWNER / tmux #S:#W / derived from the session ID) · never anonymous
adr:                    # optional · pointer to the linked decision · read it before starting
design:                 # required for multi-party sequencing tasks (design gate): pointer to the design alignment note; with no multi-party sequencing, write n/a·<one-line reason>
grill:                  # required for non-trivial tasks (grill gate · epic / spans ≥2 modules): pointer to the grilling record (epic member tasks point at the same one); trivial tasks write n/a·<one-line reason>
capability:             # optional · feature pointer: the feature's current-state doc (such as docs/capabilities/<x>.md); without one, write <feature name>·no doc · answers "which feature is this task about"
pr:                     # optional · linked PR number
touches:                # ★ soft lock: files or directories to change · the guard detects conflicts from this
  - app/core/
success:                # ★ SDD · what counts as done: checkable criteria · test cases and acceptance reports check against each one
  - <user-observable behaviour 1>
constraints:            # SDD · the floor: what must never happen · invariants shared across tasks are pointers (to design/adr), not copies · delete when none
sessions:               # append-only history: owner | session-id | date (appended at claim · a new line per relay)
handoff:                # append-only handoffs: <date> <owner> | done X · Y left · next step at file:line (≤1 line each)
acceptance:             # one-line pointer to acceptance evidence · the guard requires it when moving to staging-verified; purely internal changes write "internal only · closed by CI" (the done-gate exemption value)
staging_verified_at:    # ISO time written when moving to staging-verified (reminder anchor · nothing in this package reads it; used by the full-flow Loop)
waiting_on:             # required when verified: decision = waiting on a decision (the only one to chase) / prod / observe / external
notes: one-line conclusion  # always a single line of current state · details go under "## Timeline"; no narrative, no prepending
---
# CORE-001 · Title (human-readable body · machines only change the frontmatter, never the body)

## Alignment
<!-- Summary of the grill decision tree: one line per fork, "question → decision + rejected options (why rejected)" · always keep rejected options · do not copy the transcript;
     when evidence overturns a decision, append a dated line "verification gate fired (<date>): <evidence> · switching to <fallback>"; never overwrite the original line -->
- <fork 1 → decided Y · rejected X (reason)>

## Scope
- In: <how far it goes>
- Out: <adjacent features explicitly excluded>
- Depends on: <which task blocks it · delete when none>

## Timeline
<!-- append-only · newest first · `- <date> <owner> | <event>` · one event per line, never merged; coordination lines start with "coordination:".
     Reading on takeover: the newest non-coordination line is the latest real state. The only body section any owner may append to -->
- <date owner | event>

Copy to `.foreman/tasks/<domain>/active/<task_id>.md` and edit the frontmatter.
- Slicing test (tracer bullet): each task cuts through every layer, can be demoed on its own, and fits in one context window.
- Cold-start contract: progress and next step reflect the current truth on origin/main (merged work carries its merge SHA); live state you could not read is marked "must check live".
  Fresh over detailed · pointers over descriptions · honest gaps over a show of completeness.
- The guard applies touches only when status ∈ {claimed, in_progress}; directories end with `/`.
