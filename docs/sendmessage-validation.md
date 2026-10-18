# Director–worker messages over SendMessage: validation

Run on 2026-10-18 with Claude Code 2.1.302, for NAWABAN-SENDMSG-001. Times are local (UTC+9); transcript timestamps were converted.

Before this change, a worker's Stop hook and the director's Stop hook polled the board for each other's letters and woke their own session with exit code 2, and a director that was not the dispatching session replied with `claude stop` + `claude --bg --resume`. In the T9 A0 pilot, waking a background director that way changed its session ID (`60038f56` → `3ef9d624`). Now both directions use SendMessage, Claude Code's cross-session messaging, and nothing polls.

## How SendMessage behaves (spike)

Throwaway sessions `spike-*` in `~/Developer/sendmsg-rehearsal/spike`, with a logging plugin (`--plugin-dir`) that wrote every Stop and `PostToolUse(SendMessage)` payload to `hooklog.jsonl`.

| Question | Observed |
|---|---|
| Can a Stop hook make a background `auto` session send a message? | Yes. `{"decision": "block", "reason": …}` made the session call SendMessage with the given `to` and text; the next Stop carried `stop_hook_active: true` |
| What does `PostToolUse` get? | `tool_input.to` / `tool_input.message`, and `tool_response.success` (`true` plus `msg_id` when sent) |
| Does a message wake an idle background session? | Yes: `spike-dir` was idle after its first turn and started a new turn when the worker's report arrived |
| Sending to a stopped session | `tool_response.success: false`, `message: "No agent named 'spike-dir' is reachable. Did you mean: spike-def?"`. Nothing is queued. The sender retried once with the same name and did not switch to the suggested one |
| Addressing after a restart | This session was resumed during the work: its pid went from 34001 to 86150 and its socket path changed with it; its session ID and its name `nawaban-sendmsg-001` stayed. Address by name, not by the `uds:` path |
| Environment of `--bg` sessions | A variable set when starting `claude --bg` did not reach that session's hooks; the session ran with the environment of the already running Claude Code daemon (the R-2 run below saw its `HERDR_ENV=1`). Hooks find the board from their `cwd` |
| `claude agents --json` | About 0.2 s; it has `sessionId` and `name` but no pid or socket |

### Permission modes

The SendMessage tool description says a session in a different permission mode holds incoming messages for its user's approval. That was not observed:

| Sender → receiver | Delivered and acted on | Prompt on the sending side |
|---|---|---|
| interactive `auto` → background `default` (`spike-def`) | Yes, replied `GOT-B` | No |
| background `default` → background `auto` (`spike-wrk`) | Yes, replied `GOT-C` | No |
| background `auto` (Stop hook report) → interactive `default` (`spike-int-def`, Herdr pane) | Yes, the pane showed `Message from @spike-wrk` and the session answered | No |
| interactive `default` → background `auto` | Yes, round trip `GOT-E` back to the interactive session | No |

So a director in `default` mode and workers in `auto` (what `dispatch` starts) exchange messages without anyone approving them. Not checked: `plan` or `bypassPermissions` on either side, and the hold behaviour on a Claude Code version other than 2.1.302.

## End-to-end rehearsal (background sessions)

A throwaway repository `~/Developer/sendmsg-rehearsal/repo` with its own `.nawaban/nawaban.db`, one task `R-1` ("write `step1`, ask the director for line 2, write it"), and `.claude/settings.json` disabling the installed `nawaban@nawaban` plugin. The director was a background `auto` session (`rehearsal-director`) started with `--plugin-dir` set to this branch's worktree. It dispatched with a `claude` wrapper first on `PATH` that adds the same `--plugin-dir` to `claude --bg`, so the worker loaded this branch's hooks too. The dispatch record carried `"name": "r-1"`, which only this branch writes. Identities were the sessions' own `ac:<session ID>` on the throwaway board.

| Time | Step | Evidence |
|---|---|---|
| 06:11:57 | Director dispatches `R-1` | Dispatch record: `backend: claude-bg`, worker session `261bffaa`, director `aee8ab53` |
| 06:12:02 | Director's turn ends; it is idle | Director transcript: `turn_duration` |
| 06:12:14–06:12:29 | Worker claims (06:12:14) and starts (06:12:18) `R-1`, commits line 1, sends `notify --kind blocked` (letter #1, 06:12:29) | `task_events` 2–3, letters #1 |
| 06:12:45 | Worker stops; the hook writes turn letter #2 (no `[待 review]`: the turn had a blocker) and blocks the stop | letters #2 |
| 06:12:52 | Worker sends the report with SendMessage `to="rehearsal-director"` | Worker transcript |
| 06:12:53 | Idle director wakes with `<cross-session-message … from-name="r-1">[nawaban] worker 回报 · R-1 …` | Director transcript; letter #2 `read_at` 06:12:53 |
| 06:12:57 | Director replies with SendMessage `to="r-1"`, "第二行写 ORANGE" | The PostToolUse hook wrote reply letter #3 (sender `aee8ab53`, read at 06:12:58) |
| 06:12:57–06:13:14 | Worker wakes with the reply (`from-name="rehearsal-director"`), writes and commits line 2, sends `done` (letter #4, 06:13:14) | Worker transcript; letters #4 |
| 06:13:22 | Worker stops; turn letter #5 starts with `[待 review]`; sent at 06:13:28 | letters #5 `read_at` 06:13:29 |
| 06:13:29 | Director wakes with the `[待 review]` report and its review instructions | Director transcript |

Both reports the worker sent were character-for-character the text the hook gave it (`~/Developer/sendmsg-rehearsal/fidelity.py` compared the `<<< … >>>` block in the hook's reason with the SendMessage input).

Session IDs from `claude agents --json`, taken before the reply, after it, and at the end:

| Snapshot | `rehearsal-director` | `r-1` |
|---|---|---|
| 06:12:48 (first report, before the reply) | `aee8ab53-72f1-4305-ac09-880396db9bd2` | `261bffaa-010e-4a08-8616-3bf24eefc4a1` |
| 06:13:00 (after the reply) | `aee8ab53-72f1-4305-ac09-880396db9bd2` | `261bffaa-010e-4a08-8616-3bf24eefc4a1` |
| 06:13:41 (both idle) | `aee8ab53-72f1-4305-ac09-880396db9bd2` | `261bffaa-010e-4a08-8616-3bf24eefc4a1` |

Neither transcript has a line with another session ID.

### Second run on the final code (R-3)

After review fixes (a report is confirmed only by its exact text, a stop after more work is reported again, a worker's own messages are recorded, finished or handed-off workers are not blocked), the same rehearsal ran again at `ef835c6` on task `R-3`, director `rehearsal-director-3` (`025b8241`), worker `r-3` (`b49ee99a`), `"backend": "claude-bg"`:

| Time | Step | Evidence |
|---|---|---|
| 06:41:41 | Worker sends `blocked` after committing line 1 | letters #9 |
| 06:42:00 → 06:42:09 | Turn letter #10 written, sent, marked read | letters #10 `read_at` |
| 06:42:12 | Director (woken from idle) replies "第二行写 GRAPE" with SendMessage | reply letter #11, read at 06:42:13 |
| 06:42:37 | Worker commits line 2, sends `done` | letters #12 |
| 06:42:44 → 06:42:52 | `[待 review]` turn letter #13 written, sent, marked read | letters #13 `read_at` |

Both reports were identical to the hook's text. `claude agents --json` at 06:42:10 (before the reply) and 06:42:54 (after): director `025b8241-b5fd-4e46-94bd-cefbf849b0b0`, worker `b49ee99a-ac77-4560-9ba8-3a5525cb4423`, unchanged. (The `state` field lagged: the director still read `working` minutes after its transcript shows the turn ended at 06:42:56.)

A run in between (`R-2`) was discarded: its director's `dispatch` took the Herdr branch, because a background session gets its environment from the Claude Code daemon, which had `HERDR_ENV=1`; the Herdr worker was started without this branch's plugin and wrote no turn letter. `R-3` was dispatched with `HERDR_ENV=0`.

### The other side not running

Director stopped (`claude stop 025b8241`), then `r-3` was asked to stop once more. Its Stop hook wrote turn letter #14 (`read_at` empty) and blocked with: `主控会话 025b8241 现在不在运行(claude agents 里没有它),R-3 这一轮的回报已存进任务库 letters #14,没有送出;主控回来后在 notifications 里能看到。不要调 SendMessage,也不要改发给别的会话。` The worker did not send anything to the director, said the report was kept in #14, and stopped; the next stop passed.

Worker stopped, director sending (first run):

After `claude stop 261bffaa`, the director was asked to send "第三行写 LEMON" to `r-1`. SendMessage returned `No agent named 'r-1' is reachable.`; the PostToolUse hook wrote reply letter #6 with `read_at` empty and gave the director: `[nawaban] 话没送到 worker r-1(R-1):No agent named 'r-1' is reachable. 这条话已存进任务库 letters #6,没有送达。… 不要用 claude --bg --resume 去叫它。` The director repeated that and stopped.

### Real board untouched

On `/Users/victor/nawaban/.nawaban/nawaban.db`, read-only, after all three runs: no task `R-1`–`R-3`, and no letters, events or task sessions from any of the six rehearsal sessions or with the rehearsal's words (0 rows each).

## Behaviour changes

- The Stop hook is synchronous now (no `async` / `asyncRewake`), so it can block. Each worker stop costs one extra short model turn: the SendMessage call and a closing line.
- Directors no longer start a waiting process when they stop, and `report-wait/<session>.pid` files are no longer written.
- A Herdr worker pane closed before its task is finished still gets the `pane closed` event and an unread `turn` letter, but nothing wakes the director for it: waking needs a Claude session to call SendMessage, and the pane watcher is a plain process.
- Publishing: hook scripts are read on every call, but a session keeps the hook registration it started with. A worker still on the old `async` + `asyncRewake` registration runs the new script, whose `block` an async hook ignores: its turn letter is written but reaches the director only if an old director waiting process is still running. Publish between batches, or restart running director–worker pairs after publishing.
- `notify --kind reply` still records a reply but no longer reaches the worker. `nawaban prompt` (Herdr pane) still works and is no longer needed for replies.

## Not verified

- A Herdr-backend worker in this flow end to end (the rehearsal used `claude --bg`; SendMessage addresses both kinds of session by name, and the spike's interactive session was in a Herdr pane).
- Two live sessions sharing the director's name. `[ref]` from ListAgents disambiguates, but `claude agents --json` does not expose it, so the hook would pass the bare name.
- Plugin sessions that started before this change keep the old async Stop hook registration until they restart (whether a `hooks.json` change needs a new session is unverified, see [worker-backend-validation.md](worker-backend-validation.md)).

## The turn that finishes a card (NAWABAN-SENDMSG-002)

Run on 2026-10-18 with Claude Code 2.1.302. Times are local (UTC+9).

At c4341e3 the worker's Stop hook dropped every card that was already done or handed off before it looked at the turn, so the turn that moved a card there was neither blocked nor sent. In the T9 A0b pilot the review worker registered the merge SHA, moved both cards to done, sent `notify --kind done` (letters #6) and stopped; the director was never told and sat idle for 21 minutes.

Now a finished or handed-off worker is reported like any other, except for a stop that did no work. Each turn letter records in `provenance.offset` how far the transcript had been written when it was posted. When the card is finished or handed off, a stop passes without writing or sending only if the transcript after that offset has no tool call other than sending the report (`SendMessage`, `ToolSearch`, `ListAgents`). So the turn that finishes the card is sent; a turn that fixes review findings after the hand-off is sent, whether or not the worker claimed the card again; a turn that only answers a message is not. An unreadable transcript, or a last letter without an offset, counts as work. The turn is marked `[待 review]` only when the card is not finished: a hand-off on an `in_progress` card is a hand-in for review, a `done` card has nothing left to review.

An earlier version of this fix (b879af3–f063e67, runs 1 and 2 below) marked the finishing letter `"settled": true` and passed every later stop. Review #74 sent it back: re-claiming, fixing and handing off again in one turn, or fixing review findings without re-claiming, then stopped silently. That is the review send-back loop's main path.

| Test | c4341e3 | f063e67 | now |
|---|---|---|---|
| `test_the_turn_that_finishes_the_card_is_sent_once_then_stops_pass` (done / staging-verified / handed_off) | fail ×3 | pass | pass |
| `test_work_after_the_hand_off_report_is_reported` (reclaimed and handed off again / fixed without reclaiming) | fail ×2 | fail ×2 | pass |
| `test_a_finished_worker_without_a_readable_transcript_is_still_reported` | fail | fail | pass |
| `test_a_worker_that_starts_again_after_handing_off_reports_again` (re-finish step) | fail | pass | pass |

### Rehearsal

The throwaway repository and board from the runs above (`~/Developer/sendmsg-rehearsal/repo`, its own `.nawaban/nawaban.db`), with new cards. A new directory for this run could not be used: background sessions refuse an untrusted folder, and accepting the trust prompt was not allowed from this session. Scripts are in `~/Developer/sendmsg-rehearsal/r002/`. The director was a background `auto` session started with `--plugin-dir` set to this branch's worktree, and dispatched with `HERDR_ENV=0` and the `claude` wrapper so the workers loaded the same plugin.

A review worker's session cannot run git in the main checkout (Claude Code refuses git outside a worktree-isolated session's own worktree; the run-1 review worker hit this, reported `blocked`, and did not get around it). There is no remote and no PR, so the merge is a local `git merge --no-ff` done outside the review worker: by the rehearsal operator in run 1, by the director in run 2.

Run 1 (D-1, at b879af3, the first version: settled mark, no `[待 review]` on any hand-off):

| Time | Step | Evidence |
|---|---|---|
| 08:13:57 | Director `rehearsal-director-002` (`adeac6e4`) dispatches `D-1` and goes idle | Director transcript |
| 08:16:57 → 08:17:17 | Worker `d-1` (`9bc4aa6e`) commits, runs `handoff` (handed_off), stops; turn letter #15 (`settled: true`) is sent and read | letters #15; `task_sessions` outcome `handed_off` |
| 08:17:17 → 08:17:22 | Director wakes, dispatches `D-1-REVIEW` | Director transcript; event #20 |
| 08:21:34 → 08:22:05 | Review worker `d-1-review` (`654fb9f1`) records review #1 (pass), cannot merge, sends `blocked` (#16); its turn #17 reaches the director | letters #16, #17 |
| 08:22:38 → 08:22:59 | Operator merges (`a6b3373`), asks the director to relay the SHA; director replies to `d-1-review` | reply letter #18 |
| 08:23:21 → 08:23:36 | Review worker registers `merge_sha` on both cards, moves both to done, sends `done` (#19), stops; turn letter #20 (`settled: true`) sent, read 08:23:36 | letters #19, #20; both cards `done` |
| 08:23:36 → 08:23:42 | Idle director wakes with the done report and answers 「收到 done。」 | Director transcript |
| 08:24:49 → 08:24:55 | Operator asks `d-1-review` to say "ok" and stop: one stop, no block, no SendMessage, no new letter (still #20) | Review worker transcript; letters |

Run 2 (D-2, at 0e8d500, settled mark; before review #74):

| Time | Step | Evidence |
|---|---|---|
| 08:25:54 | Director `rehearsal-director-002b` (`e25329cb`) dispatches `D-2`, goes idle | Director transcript |
| 08:29:17 → 08:29:27 | Worker `d-2` (`174c9e6c`) commits, hands off, stops; turn letter #21 sent and read | letters #21 |
| 08:29:27 → 08:29:32 | Director wakes, dispatches `D-2-REVIEW` | Director transcript |
| 08:32:20 → 08:32:45 | Review worker `d-2-review` (`c6d5d561`) passes the review, asks for the merge (`blocked` #22, turn #23); director wakes, merges (`4769414`), replies with the SHA | letters #22–#24 |
| 08:33:01 → 08:33:12 | Review worker registers `merge_sha` on both cards, moves both to done, sends `done` (#25), stops; turn letter #26 (`settled: true`) sent, read 08:33:12 | letters #25, #26; both cards `done` |
| 08:33:11 → 08:33:15 | Idle director wakes with the done report and answers 「收到 done。」 | Director transcript |
| 08:34:20 → 08:34:24 | Operator asks `d-2-review` to say "ok" and stop: one stop, no block, no SendMessage, no new letter (still #26) | Review worker transcript; letters |

Run 3 (D-3, at 13d07d7, the hook after review #74): review sends the work back after the hand-off; the worker fixes it without claiming the card again. The director relays the review result, as it does for a review worker's findings.

| Time | Step | Evidence |
|---|---|---|
| 08:53:59 | Director `rehearsal-director-002c` (`1653c370`) dispatches `D-3`, goes idle | Director transcript |
| 08:54:33 → 08:54:55 | Worker `d-3` (`3d12ace5`) commits, hands off (handed_off), stops; `[待 review]` turn letter #28 (`offset` 887860) sent and read | letters #28; `task_sessions` outcome `handed_off` |
| 08:54:55 → 08:54:59 | Director wakes, replies 「review 打回:… 第二行写 FIXED。不要重新认领…」 | reply letter #29 |
| 08:54:59 → 08:55:31 | Worker wakes, edits and commits without claiming again (card still handed off), stops; `[待 review]` turn letter #31 (`offset` 1246034) sent, read 08:55:31 | letters #30, #31 |
| 08:55:31 → 08:55:33 | Idle director wakes with the fix report and answers 「收到修复。」 | Director transcript |
| 08:55:48 → 08:55:52 | Operator asks `d-3` to say "ok" and stop: one stop, no block, no SendMessage, no new letter (still #31) | Worker transcript; letters |

Run 4 (D-4, at 13d07d7): run 2's flow again on the hook after review #74.

| Time | Step | Evidence |
|---|---|---|
| 08:56:56 | Director `rehearsal-director-002d` (`449015a7`) dispatches `D-4`, goes idle | Director transcript |
| 08:57:49 → 08:58:00 | Worker `d-4` (`1231b8e0`) commits, hands off, stops; `[待 review]` turn letter #32 sent and read | letters #32 |
| 08:57:59 → 08:58:04 | Director wakes, dispatches `D-4-REVIEW` | Director transcript |
| 08:58:55 → 08:59:30 | Review worker `d-4-review` (`ed7ef75c`) passes the review, asks for the merge (`blocked` #33, turn #34); director wakes, merges (`76873c6`), replies with the SHA | letters #33–#35 |
| 08:59:58 → 09:00:13 | Review worker registers `merge_sha` on both cards, moves both to done, sends `done` (#36), stops; turn letter #37 sent, read 09:00:13 | letters #36, #37; both cards `done` |
| 09:00:12 → 09:00:14 | Idle director wakes with the done report and answers 「收到 done。」 | Director transcript |
| 09:00:32 → 09:00:36 | Operator asks `d-4-review` to say "ok" and stop: one stop, no block, no SendMessage, no new letter (still #37) | Review worker transcript; letters |

Every report each worker sent was character for character the text its Stop hook gave it (`fidelity.py`: `d-1` 1/1, `d-1-review` 2/2, `d-2` 1/1, `d-2-review` 2/2, `d-3` 2/2, `d-4` 1/1, `d-4-review` 2/2). On the real board, read-only after the runs: no task `D-1` to `D-4` or their `-REVIEW` cards, and no letters or task sessions from any of the eleven rehearsal sessions (0 rows each).

### Seen, not fixed here

- The hand-off turn in run 2 (#21) was sent without `[待 review]`. The worker had a Bash command that hit its 120 s timeout and was moved to the background, then stopped it with TaskStop; a stopped task leaves no `<task-notification>` in the transcript, so `background()` still counts it as running and the turn is treated as busy. The report was still delivered and the director still dispatched the review.
