# Hook load path and background-session worker validation

Run on 2026-10-16 with Claude Code 2.1.301. Main checkout `/Users/victor/nawaban` and this branch were both at `d57d89f`, so the dispatching CLI and the hooks ran the same code.

## Where the hooks load from

The hooks run from the checkout, not from the plugin cache.

| Check | Result |
|---|---|
| `ps -axo pid,command \| grep worker_report` | Two running Stop hooks (sessions `4af123b0`, `cf791bb0`), both `/Users/victor/nawaban/hooks/worker_report.py` |
| `ps eww -p <pid>` on each | `CLAUDE_PLUGIN_ROOT=/Users/victor/nawaban` |
| `ls ~/.claude/plugins/cache/nawaban/nawaban/0.1.0/hooks` | No `worker_report.py`; this 2026-09-17 copy cannot produce `[待 review]` letters |
| `~/.claude/plugins/known_marketplaces.json` | `nawaban` is a `directory` source, `installLocation` `/Users/victor/nawaban` |

`installed_plugins.json` still lists `installPath` as the cache copy; that record is not the runtime path. A hook script is read on every call, so pulling `main` in the checkout reaches every open session at its next hook call, without `claude plugin update`. Not verified: whether adding or removing an entry in `hooks.json` needs a new session. Because the live hooks are the checkout's working files, a branch switch or uncommitted edit in the main checkout changes the hooks of every session at once.

## Background-session dispatch, end to end

Rehearsed on a temporary repository with its own `.nawaban/nawaban.db`, a test owner, and a made-up director session ID. `HERDR_ENV` was unset so `dispatch` took the `claude --bg` branch. The director side was observed by piping `{"session_id": <director>, "cwd": <repo>}` into `hooks/worker_report.py` by hand; that is the hook command a real director's Stop runs, but Claude Code waking a real director session was not part of this run (that side does not depend on the worker backend).

| Step | Observed |
|---|---|
| `dispatch` | Dispatch record `"backend": "claude-bg"`, director = the test ID; `claude agents --json` showed the worker `kind: background` |
| Worker starts on its own | Claimed and started the card, committed step 1, stopped without `blocked` or `ask` |
| Director gets the review prompt | Director hook exited 2; text began `[nawaban] worker 回报 …` / `[待 review] …` followed by the review instructions |
| Director replies | `notify --kind reply` written at t=291 s, marked read by the worker's waiting Stop hook at t=294 s |
| Worker continues | Step-2 commit at t=300 s, then `done` and a second `[待 review]` turn; the director hook exited 2 again at t=317 s |

## Live workers unknown

With a `claude` on `PATH` that exits 1, `dispatch` printed `排队 …:查不到哪些 worker 还活着(claude agents --json 没给出会话列表),按上限 4 个已满处理`, wrote a `queued · …` event, set the card's `now` to `排队等派发:…`, and started no session. `tests/test_dispatch.py::test_when_live_workers_cannot_be_listed_the_limit_stays_full` covers the same path for exit 1, empty, malformed and non-list output.

## Found during the run

- `claude --bg` refuses a directory whose trust prompt was never accepted (`Workspace not trusted. Run claude in <dir> once …`), and trust is per exact path: a directory under a trusted `/Users/victor` was still refused. `dispatch` reports it as `会话没起来 —— Workspace not trusted …` and records no dispatch. A rehearsal therefore needs a repository at an already trusted path.
- Stopping a background worker with `claude stop` left its `~/.local/state/nawaban/report-wait/<session>.pid`; the waiting hook was killed before its `finally`. The stale file is harmless (the next waiter overwrites it) and was removed by hand.

## Cleanup

The worker session and its worktree were removed with `claude rm --discard-unpushed`, along with its transcript directory, the temporary repository and database, and the stale pid file. The real boards (`~/.nawaban/nawaban.db`, `/Users/victor/nawaban/.nawaban/nawaban.db`) have no rehearsal tasks, letters or events.
