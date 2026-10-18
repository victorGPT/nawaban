# Task inactivity on cards

Each board card shows the date of the task's last activity, pinned right in its footer. `active_at` is the time of the task's latest event, or its created time when it has none; the board API computes it (`nawaban/board_view.py`, `board_data`).

Only an in-progress task that sits still changes colour: open and finished tasks sitting still is normal. `nawaban/webui/src/lib/task-staleness.ts` owns the thresholds in seconds: yellow after 3 days, rose after 7 days. A coloured date carries "No updates for {count} days" as its tooltip and in its accessible label. Cards share a 60-second clock (`use-task-clock.ts`), which keeps ticking when board reads fail.

`nawaban/webui/tests/task-attention.test.tsx` covers the thresholds and the label.
