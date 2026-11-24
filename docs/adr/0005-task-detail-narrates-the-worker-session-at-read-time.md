# The task detail narrates what the worker did, translated by rule from its session transcript when the page reads it

Status: accepted (11-24, NAWABAN-NARRATE). The decision-maker asked for the narration and named tt-a1i/agent-worker as its model; computing it at read time, the time windows and the three rules were fixed in the brief; the rest is the worker's default and can be overturned.

A task's detail (`nawaban json task`, `GET /api/nawaban/task/:key`) gains `narration: { at, kind: 'said' | 'edited' | 'tested', text }[]`, oldest first. The web page shows it only behind 「显示全部」, among the other timeline rows; the rows up front stay the decision-maker's rulings and what was asked of them. The narration lists what happened and judges nothing: no phase, no LLM.

## Where it comes from

`board/src/narrate.ts` reads the transcript of each session that held the task:

- **Which stretches.** From each `task.claimed` to the next `task.claimed`, `released`, `completed`, `canceled`, `failed` or `expired` of that task, as the board's feed dates them; a stretch still open ends now. One transcript often holds several tasks, and one task is often claimed and released several times (released before each hold, claimed again after the answer). Only entries timed inside a stretch held by that session count, and the rules below run inside each stretch.
- **Which transcript.** The claim's profile is `cc-` or `cx-` and the first 8 characters of the session id. Claude Code: `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/*/<id>.jsonl`. Codex: `<CODEX_HOME or ~/.codex>/sessions/**/rollout-<time>-<thread id>.jsonl`; a Codex thread id is a UUIDv7, whose first 8 characters change only every 65 seconds, so when two rollouts share them the narration is empty rather than possibly someone else's. Other profiles have none.
- **Read whole, once per change.** A real transcript is 24 MB with screenshots inline, so it is streamed line by line, and what it yields is kept in memory per path, size and mtime: the page reads the detail again on every board change.

## The three rules

Rewritten in TypeScript from [tt-a1i/agent-worker](https://github.com/tt-a1i/agent-worker) (MIT), `run_worker.py`: `clean_progress_text`, `TEST_BUILD_RE`, `EDIT_TOOLS`, and the event handlers of `run_claude_like` and `run_codex`. No code is copied.

- **said**: text the model wrote just before a tool call. Claude Code writes each content block as its own entry, and such text carries `stop_reason: 'tool_use'`; Codex marks it `phase: 'commentary'`. Never thinking, never the reply that ends a turn (`end_turn`, `final_answer`). Backticks and `**` are dropped, and blank lines.
- **edited**: a call from the edit set in `progress.ts` (`TOOLS_THAT_EDIT`), or a Codex `FileChange` item, with a path: shown relative to the checkout the session started in, wherever the shell stood when it ran; a file outside that checkout (a scratch file, another repository) is left out. Edits of a file already shown since the worker last spoke add nothing; edits of other files with nothing in between join the same row.
- **tested**: a shell command matching the test or build pattern (vitest, jest, pytest, `pnpm test|build|check|lint|typecheck`, `cargo test`, `tsc`, …), read with quotes and heredoc bodies blanked as `progress.ts` does, so `rg "pnpm test"` is not a test. At most one row in 15 seconds, reading 「在跑测试 / 检查」.

Calls come from `callsOfStep` and `commandsRunBy` in `progress.ts`, plus Codex's `item_completed` `CommandExecution` and `FileChange` items. In code mode the wrapper is skipped (Claude Code's `REPL`; Codex's `exec`, whose input is a script), and the calls the script made, which each agent logs as their own entries, are narrated, so no row comes twice. Entries of a subagent (`isSidechain`) are skipped.

## Considered Options

- **Translate at read time from the transcript (chosen)**: nothing new is written anywhere, the rules can change and every past task reads under the new ones, and the hooks stay as they are.
- **Write the rows from the PostToolUse hook, as the milestone is**: rejected, the hook writes at most once in five minutes, rows would be stored for good under whatever rule was current, and a session that never ran the hook would have none.
- **Summarise with a model**: rejected, a call per read, words that can be wrong, and the decision-maker asked for what happened, not a reading of it.
- **Read the last 4 MiB, as the milestone does**: rejected, the narration needs the whole task, and the tail of a long session may hold only the next one.

## Consequences

- Only transcripts on this machine are read. A worker on another machine, an Antigravity session, or a Codex rollout whose prefix is shared narrates nothing.
- A path is shown from the directory the call ran in, so one file can read `web/src/main.tsx` and later `src/main.tsx` when the worker `cd`'d into `web`.
- The test pattern is agent-worker's: `pnpm --dir web check` is not caught, while an unquoted `cat vitest.config.ts` is.
- The first read of a large transcript after it changes costs a full parse; a held task's transcript changes all the time, so a page open on it re-reads it on each board change.
