# A claim labels the task with its Herdr terminal

Supersedes [0001](./0001-claim-records-the-terminal-in-the-event-body.md). On the board (docs/specs/board-migration.md), `nawaban claim` sets the label `terminal=<HC_TERMINAL_ID>` on the task's root when a Claude Code session claims it inside Herdr, and unsets it when the session claims it outside Herdr, releases it, or closes it. The panel reads the label directly, with no event history to walk. We chose a label because a board task has no column of ours, a label is the board's own way to annotate a thread, and the panel already reads labels.

## Considered Options

- **Keep it in the claim's event body (0001)**: rejected, the board writes its own task events, and parsing replies for it is the history-walk a label avoids.
- **Name the terminal in the profile**: rejected, the profile is `cc-<session>`, and one session can move terminals.

## Consequences

- The label holds only while the task is `claimed` with a live lease: a lease that runs out leaves it behind, since nothing runs then to erase it. Read it only for a claimed task.
- `NAWABAN_OWNER` sessions and sessions outside Herdr set no terminal.
