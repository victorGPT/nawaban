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
| Environment of `--bg` sessions | A variable set when starting `claude --bg` did not reach that session's hooks; hooks find the board from their `cwd` |
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

### The other side not running

After `claude stop 261bffaa`, the director was asked to send "第三行写 LEMON" to `r-1`. SendMessage returned `No agent named 'r-1' is reachable.`; the PostToolUse hook wrote reply letter #6 with `read_at` empty and gave the director: `[nawaban] 话没送到 worker r-1(R-1):No agent named 'r-1' is reachable. 这条话已存进任务库 letters #6,没有送达。… 不要用 claude --bg --resume 去叫它。` The director repeated that and stopped.

The worker side of the same case (its director not running) was covered by tests only: the hook names the director, says the report is kept as an unread letter, and gives no SendMessage instruction.

### Real board untouched

On `/Users/victor/nawaban/.nawaban/nawaban.db`, read-only: no task `R-1`, and no letters, events or task sessions from the two rehearsal sessions or with the rehearsal's words (0 rows each).

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
