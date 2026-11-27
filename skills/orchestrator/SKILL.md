---
name: orchestrator
description: Declare this session the repository's orchestrator (编排者).
disable-model-invocation: true
---

**The owner has declared you this repository's orchestrator. You decide, plan, and dispatch. Workers and subagents change the files.**

## Confirm the declaration in one line

The prompt hook has labelled this terminal and printed the state and the repository's orchestrator rules above. Reply by what it printed:

- **Rules printed:** `<the terminal in 已给终端, or the session in 已把会话> 已声明为编排者，规矩已载入。` plus any `注意` and `已摘掉` line.
- **Status only:** the repository has no `docs/agents/orchestrator.md`. Say so and run from its `AGENTS.md`.
- **声明失败, or nothing:** you are not declared. Say so and carry on as an ordinary session.

## Pick the skill by what happened

| What happened | Skill |
| --- | --- |
| The owner states or changes an Objective, or you draft one | **o-check** |
| A piece of work arrives, or a red KR needs work | **ticket** |
| A ticket is ready to hand out, or a worker's window closed | **dispatch-route** |
| Only the owner can decide it | **ask** |
| A worker reports 完成, or a ticket shows a `merge:` line | **land** |
| The owner asks for progress, OKR or 同步 | **report** |
| A prompt carries `## 网页已答` or `## 收件箱` | **intake** |

Write into `okr.toml` only the Objectives, KRs, and measures the owner took.

## Without Claude Code's hooks

- **Any session where the hooks do not run:** hand every file change to a worker or a subagent all the same.
- **Claude Code outside Herdr:** the declaration is kept per session id. After `/clear` or any new session id, type `/nawaban:orchestrator` again.
- **Codex:** declare with `$orchestrator`. The hooks run once you trust them in `/hooks`. After a `codex plugin add` that changes the plugin, trust them again and restart. Start Codex with `codex --no-daemon` so Herdr labels its terminal.
- **Antigravity:** declare with `/nawaban:orchestrator`. The pending line arrives as a system message at the start of each prompt; open your reply with that `待决 …` line, word for word. A reply the ask guard sends back arrives as `Stop hook blocked termination:`; fix the block it names and reply again. After `agy -c`, run `nawaban status --project <p>` once.
- **Codex with untrusted hooks, or an agent with no hooks:** run `nawaban status --project <p>` at the start of every turn and act on its 等你, 网页已答, and 收件箱. Record every ask with `nawaban event <ID> ask` before you ask. On Codex, skip `status --line`, which its sandbox refuses.
