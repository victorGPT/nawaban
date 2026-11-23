---
name: nawaban
description: The nawaban board is the issue tracker. Use when a skill says to publish a spec, "publish the tickets" or "fetch the ticket" (each ticket is a task), or to find the frontier; before working on a task; and when recording a note, a decision between options, or a link such as a pull request.
---

# nawaban issue tracker

A nawaban board records **tasks** and an append-only **event** log per task. It holds no workflow: the engineering skills (`/to-spec`, `/to-tickets`, `/implement-spec`, `tdd`, `code-review`) decide what to do; the board records what was decided and done.

## Rules

1. **Three questions for the user.** Bring the user only questions about how the product should behave, what is said to the outside, and whether something goes to production. Settle every other choice yourself. A step the running skill marks as the user's (approving the split in `/to-tickets`, confirming the seam in `/to-spec`, `grilling`, a wayfinder HITL ticket) goes to the user as written; this rule governs only the choices outside those steps.
2. **Every choice becomes a 决策记录.** Whenever you choose between options, record it (see "Record events"), including the user's answers to the three questions above.

Nouns are the Chinese terms in `GLOSSARY.md` (each entry names its English source): 待决策项（待决）, 上升, 就绪标准, 决策记录, 完成标准, 停滞 / 进行中 / 待办 / 已完成, 负责人, 红黄绿灯, 偏差. What people and agents read uses these; the English names (BLUF, Context, …) are still read where formats are parsed.
3. **Claim before work.** Claim a task before working on it, and close or release it when you stop.

## The command

The CLI is `nawaban/cli.py` in the plugin root, two directories above this skill's base directory. Below, `nawaban` stands for:

```
python3 <plugin root>/nawaban/cli.py --db <absolute board path>
```

Use the board the project names (its `CLAUDE.md` or `docs/agents/issue-tracker.md`); otherwise the CLI finds `.nawaban/nawaban.db` in the repository's main checkout. Always pass the absolute `--db`, also from worktrees, so every worktree writes one board. Write the whole command out in every call. Do not keep it in a shell variable (`N="python3 ..."; $N list`): a subagent's Bash refuses a command whose name is computed at runtime, and zsh does not split the variable. `nawaban <verb> --help` lists a verb's flags. Output is in Chinese: `✓` is success; `✗` with exit 1 is a refusal or an unknown id.

Identity comes from `CLAUDE_CODE_SESSION_ID`, then `NAWABAN_OWNER`. A session without either (Codex) sets `NAWABAN_OWNER` to a stable name before claiming or writing events.

## Task shape

- **id**: any string without whitespace, e.g. `LEAN` or `LEAN-03`.
- **title**: what a person can see once it is done.
- **body**: markdown. A task's body has two sections, `## What to build` and `## Acceptance criteria`; a spec task's body is the whole spec. Write the body to a file and pass `--body-file`.
- **project**: defaults to the parent's project, then to the git repository the command runs in (its main checkout, also from a worktree), then to the repository holding the board. Pass `--project` only to override.
- **status**: `open`, `done` or `cancelled`. "In progress" is derived: an open task held by a session.

## Publish a spec

```
nawaban create <SPEC-ID> --title "<title>" --body-file <spec.md>
```

## When a skill says "publish the tickets"

Create one task per ticket, blockers first:

```
nawaban create <SPEC-ID>-<NN> --title "<title>" --parent <SPEC-ID> --body-file <task.md> --blocked-by <ID> --blocked-by <ID>
nawaban block <ID> <blocker ID>
```

`block` adds an edge afterwards. Both refuse unknown ids, a task blocking itself, and cycles. Leave the spec task unchanged.

## When a skill says "fetch the ticket": fetch a task or a spec

- `nawaban show <ID>`: title, status, project, parent, holding session, current progress (the latest note, shown for open tasks only), the tasks it is blocked by and its dependents with their status, the body, and the latest 20 events.
- `nawaban list --parent <SPEC-ID>`: every task of a spec, one line each: `<id>  <status>  <project>  <title>`. `nawaban list --project <name>` filters by project.
- `nawaban json projects`, `nawaban json board [--project <name>]`, `nawaban json task <ID>`: the JSON the Herdr panel reads, on stdout, read-only. An unknown id or a missing board prints `{"error": ...}` on stdout and exits 1.

## Index: read it first

As the orchestrator, run `nawaban index` when you start and again after your context is compacted, before you rebuild what is going on from memory. It prints, from the same data as `json board` (the repository's GitHub issues when its `docs/agents/issue-tracker.md` names GitHub, else the board; `--project <name>` on the board), an md index on stdout: on GitHub, first the 待决策项 (`## 待决`, oldest first, each by its issue number and title); then what waits on the user (等你, on the board only), what has had no activity for 24 hours and on whom it stopped (停滞), what moves (进行中), each with the spec it belongs to, its latest progress and its next step (the `下一步：` of a 进展同步), or the 决策记录 that came after that step; the user's 决策记录 of the last 48 hours (on GitHub, every `已决：`, a `决定：` whose marker says `by: user`, and a `决定：` whose marker names no `by` (or that has no marker) that says `拍板` or names one of the comma-separated `NAWABAN_OWNER_NAMES`); what nobody has touched (待办); and how many closed. It writes nothing on the tracker; on GitHub it rewrites the inbox cache. A project moved to the Vercel Board (`cliFor` in the Herdr mod's `logic.js`, which `hooks/route.mjs` reads for the hooks) gets the same index from `node board/src/cli.ts index --project <name>`, which the SessionStart hook runs for it.

For the owner's Progress, run `nawaban okr` in the repository: it reads `docs/agents/okr.toml` (each `[[objective]]` with its `[[objective.kr]]`: `name`, `target` such as `>= 95`, optional `unit`, optional `max_age_days` (a reading dated longer ago than this is stale, not met; the as-of must then start with `YYYY-MM-DD`), optional `wait` (what the decision-maker has to do before a KR without a measure can be measured), and `measure`, a shell command run from the repository root that reads results already produced and prints `<number> <as-of>` as its last line), runs every measure, and prints each Objective with how many KRs are met (`n/m 达标`), each KR as `<KR>  <实际> / 目标 <op 目标> · 偏差 <±n 单位> · <红|黄|绿> · 截至 <MM-DD>` (红灯 未达标, 黄灯 过期或有风险, 绿灯 达标; a KR with no reading is `未测 / 目标 <target>`, a failed measure adds `· 测量失败：<why>`), and the definitions' commit. 偏差 is actual minus target in the target's direction: `+` ahead, `-` behind; percent is counted in 点. Report its numbers, not your own. A measure never runs an eval. Each reading whose as-of starts with a date is kept on the board once (under the main checkout, even from a worktree); a failed or untested KR keeps nothing. `nawaban okr --accept "<Objective>"` records the decision-maker's sign-off, only while that Objective is all ✓ in the same run. `nawaban json okr [--repo <path>]` reads only the board and `okr.toml` (it runs no measure) and lists, under `attention`, what the decision-maker must watch: `stuck` (missed, two rounds not closer), `five` (missed five rounds in a row), `wait` and `accept` (all met, not accepted since the last miss).

In a repository whose `docs/agents/issue-tracker.md` names GitHub, write an issue's state with the same verbs on `'#N'`, run from that repository: `claim '#N'` (assigns you and posts the claim; `--release` hands it back), `event '#N' --kind note|decision|link|ask|resolve --body …` (进展, 决定, PR, 待决, 已决), `close '#N' --done|--cancelled|--reopen`. Each comment carries a marker the readers trust over its text; a hand-written prefixed `gh issue comment` is blocked by the plugin's hook. An issue holds one 待决策项: a second `ask` is refused until a `resolve`. 上升 means raising a 待决策项; the owner is the one who decides. An `ask` is written as

    决策事项：<the one decision asked>      (--body)
    关联 KR：<Objective / KR, or 无>        (--kr)
    背景：<only the facts it turns on>       (--context)
    备选方案：                              (--option, at least twice)
    - <方案> ｜ <代价> ｜ 单向门|双向门
    建议：<which 方案 and why>               (--rec)

就绪标准: every part present and not a placeholder (`无`, `none`, `-`; 关联 KR may be `无`), each 方案 with its 代价; on the Vercel Board each also names its door. A 待决策项 that is 未就绪 is refused when written, and one read off an issue is kept out of the panel and returned to the orchestrator. Readers still take the English `BLUF: / KR: / Context: / Options: / Recommendation:` form and the older `【Decision】…【Recommendation】` form. A `decision` you take yourself on the owner's behalf names its KR with `--kr`, so the owner's report can list the delegated decisions that move a KR. When you relay the decision-maker's own call, record it as `event '#N' --kind decision --by user` (its marker carries `by: user`, which the index counts whatever the text says), or as `resolve` on an issue with a 待决.

On GitHub, `nawaban brief` gathers the raw material for 待决策项: for each one, oldest first, its issue number, title, when it was raised (`MM-DD HH:MM 提出`) and URL, its text verbatim (`原文：`), and its issue's last 3 `进展：` comments (`近期进展：`). When the user says 同步, run it and turn that material into 待决策项 yourself; it is not for pasting as it is. It is refused on the board.

As the orchestrator you also get the pending line (待决提示行): after each of your replies the plugin's Stop hook shows the decision-maker one line, `待决 N 件：<new items>｜说「同步」看待决` (or `待决 N 件（无变化）`), counted from the tracker only: the 待决 on GitHub, the 等你 tasks on the board. A question you ask only in chat is not in it; record it as an `ask` (GitHub) or a `triage: needs-info — 等你：` note (board). A reply that asks for a decision without one recorded that turn is sent back by a second Stop hook (`hooks/ask-guard.sh`, keyword-based). On GitHub the line reads a cache that `index`, `brief`, `json board`, `ask` and `resolve` refresh; past 5 minutes it carries its age while the hook refreshes it in the background. For a project moved to the Vercel Board the hook runs `board/src/cli.ts inbox`, which reads that project's tasks held as 等你 (`needs_input`) or for a 待决策项 (`awaiting_approval`) off the board each time, with no cache.

## Frontier

```
nawaban list --parent <SPEC-ID> --frontier
```

The frontier is every open task that no session holds and whose blockers are all done or cancelled. Without `--parent`, the list includes spec tasks too. Nothing stops a claim on a task outside the frontier; check it yourself.

## Claim, release, close

- `nawaban claim <ID>`: the task becomes yours. A task held by another session is refused with the holder's session id; take it over only on purpose, with `--take`, which is logged. A done or cancelled task is refused; reopen it with `close --reopen` first.
- `nawaban claim <ID> --release`: hand back a task you will not finish; it returns to the frontier. Record a 进展同步 (`已完成：… / 下一步：… / 卡点：…`) first.
- `nawaban close <ID> --done` once its work is merged into the integration branch, after a link event for the pull request or commit: that merged link is the 完成标准. In a repository with `docs/agents/okr.toml` it is refused until the task has a KR impact declaration (see "Record events"); `--cancelled` is never refused. `--cancelled` for work dropped; `--reopen` for a task closed by mistake. Closing clears the session.

Every claim, takeover, release and close writes a status event by itself.

## Dispatch tasks to Herdr workers

    nawaban dispatch <ID> --brief "<goal, scope, what not to touch>" --accept "<checkable done, output to paste>"

In a GitHub-tracked repository `<ID>` is `#N`. It refuses a closed ticket, pulls a worktree off `origin/main` beside the repository, starts the worker there with the one report protocol in its brief, and records the worker's terminal and the acceptance on the ticket (on a local board as a `dispatch: <name>` note, which names you the task's orchestrator in the Herdr panel). Reports go to the repository's orchestrator, the terminal the owner labelled `role=orchestrator`; with none alive, nothing starts. While dispatching, hold no task yourself; progress is on the ticket. Once the task is closed, `hc kill <name>`; the worker removes its own worktree. A hook refuses `hc kill` and `hc rm` while the worker's terminal still holds an open ticket (claimed on the board, or assigned on GitHub with that terminal on its latest dispatch or claim): have the worker close it with `--done` after recording the `pr:` link, or release it with `claim --release` after a note on where it stopped (on GitHub you can do either yourself).

## Record events

```
nawaban event <ID> --kind note --body "已完成：<what is done> / 下一步：<next step> / 卡点：<what stops it, or 无>"
nawaban event <ID> --kind decision --body "决定：<what was chosen and why>
背景：<the question and the facts it turned on>
否决方案：<option> — <why not>
影响：<what follows, optional>"
nawaban event <ID> --kind link --body "pr:<url>"
```

- A note is the 进展同步 others see; record one at each stopping point, and as the handoff before a release, in the 已完成 / 下一步 / 卡点 form. The index shows its 已完成 as progress and its 下一步 as the next step. `Done: / Next: / Blockers:` is still read.
- A decision is a 决策记录. `Decision: / Context: / Rejected: / Consequences:` and the older `Question:` / `Verdict:` are still read. On the Vercel Board, 背景 is kept as the question and 影响 after the decision.
- A decision the user made gets `--by user`; without it the author is your identity.
- Link prefixes: `pr:`, `commit:`, `artifact:`, `adr:`.

### KR impact declaration

Before a ticket closes as done or its pull request merges, declare which KRs it moves:

```
nawaban event <ID> --kind impact --o "<Objective name>" --kr "<KR name>=↑ 90→95 预计" --kr "<KR name>=="
nawaban event <ID> --kind impact --o 无
```

- `--kr` is `<KR name>=↑|↓|=[ <before>→<after> 实测|预计]`, repeatable; ↑ and ↓ need both numbers and 实测 (measured) or 预计 (expected). A KR not listed is `=`. Pure infrastructure is `--o 无` with no `--kr`.
- The Objective and KR names must exist in the repository's `docs/agents/okr.toml`; run it from that repository. In a GitHub-tracked repository the ID is `'#N'`.
- The declaration is kept on the local board (`kr_impacts`) and recorded on the ticket: a note `impact: …` on the board, a `影响：` comment with its marker on GitHub. The locks read only the local board.
- In a repository with `okr.toml`, `close --done` is refused without one, and the plugin's hook denies `gh pr merge` and `scripts/merge.sh <PR>` until every ticket the PR is linked to (its closing issues, `Refs #N` in its body, or an open board task named in its title, body or branch) has one: GitHub closes an issue on merge without `nawaban close`.
- Triage labels are notes: `--kind note --body "triage: <label>"`.

## Waiting on the user

When the work needs the user to answer or act, ask in the conversation as usual and record

```
nawaban event <ID> --kind note --body "triage: needs-info — 等你：<one-line question or what the user must do>"
```

Keep holding the task. The Herdr panel shows it under 等你 with that line. Once the user answers, record the answer as a decision with `--by user`, then a note `triage: ready-for-agent`.

## Wayfinder maps

A wayfinder map is a parent task with a note `wayfinder: map`. The board has no command that edits a body, so the map's body stays as first written and its events carry the changes:

- A ticket is `nawaban create <ID> --parent <MAP>` plus a note `wayfinder: <type>`, with no `triage:` prefix. A ticket blocking another is `nawaban block`. The frontier is `nawaban list --parent <MAP> --frontier`.
- Resolving a ticket:
  1. Record its full conclusion as a decision on the ticket, and a note on the map `decided: <ticket ID> <ticket title>: <one-line conclusion>`. These notes are the map's Decisions so far.
  2. A research ticket: a link `commit:<sha on the research branch>`, then `close --done`.
  3. A grilling ticket: `close --done` after its decision.
  4. A ticket out of scope: `close --cancelled`, and a note on the map `out-of-scope: …`.
- Fog that becomes a ticket: a note on the map `graduated: <fog> → <new ticket ID>`.
- Removing a ticket: `close --cancelled` plus a note with the reason.

## Back up

- `nawaban backup`: copy the board into `backups/` beside it with a timestamp; copies older than 14 days are pruned. Run it before risky changes.
- `nawaban init`: create an empty board, only when connecting a new project.
