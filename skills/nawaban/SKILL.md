---
name: nawaban
description: The nawaban board is the issue tracker. Use when a skill says to publish a spec, "publish the tickets" or "fetch the ticket", or to find the frontier; before working on a ticket; and when recording a note, a decision between options, or a link such as a pull request.
---

# nawaban issue tracker

The board holds 票 and an append-only event log per 票. The engineering skills decide what to do. The board records what was decided and done. Nouns are the Chinese terms in `GLOSSARY.md`.

Run `node <plugin root>/hooks/route.mjs` in the repository, with the plugin root two directories above this skill. It prints `board <project>` or `old`. On `board`, follow "Repositories on the board". On `old`, and for every GitHub issue `'#N'`, follow the board section with the differences in "Repositories on the old CLI or GitHub". A session outside Codex, Antigravity and Claude Code sets `NAWABAN_OWNER` to a stable name before it writes.

## Rules
1. **Three questions for the user.** Bring the user only questions about how the product behaves, what is said to the outside, and whether something goes to production. Settle every other choice yourself. A step the running skill marks as the user's, such as approving the split in `/to-tickets`, `grilling` or a wayfinder HITL 票, still goes to the user.
2. **Every choice becomes a 决策记录.** Record each choice between options as a `decision` event, the user's answers included.
3. **Claim before work.** Claim a 票 before you work on it. Close or release it when you stop.

## Repositories on the board
Run `nawaban <verb>` from PATH. `<票>` is the KEY or the board number, with no `#`. Every verb takes `--help` and `--json`. Do not type `nawaban json`, which only the Herdr panel reads. Output is one or two lines of Chinese that start with `✓` or `✗`. Exit 0 is success, 1 a refusal, 2 a usage error, and 3 still waiting. `nawaban board <native verb>` runs an `@vercel/board` verb, such as `board label` or `board tasks assign`.
- `nawaban status` prints 等你, 停滞, 进行中 and 待办, each 票 with its latest 进展同步 and next step. `--project` defaults to this repository's project. With a project it ends with the live workers, 网页已答 and 收件箱. As the orchestrator, read it at the start and after compaction, before you rebuild the state from memory.
- `nawaban show <票>` prints the 票, its holder, its blockers and its latest event. `show <票> --all` prints every event.
- `nawaban list [--project <p>] [--parent <票>] [--frontier]` prints one line per 票. The frontier is every open 票 that no session holds and whose blockers are all done or cancelled. Nothing stops a claim outside the frontier, so check it yourself.
- `nawaban okr` runs each KR's `measure` in `docs/agents/okr.toml` and prints its reading against the target, its 偏差 and its 红黄绿灯. Report its numbers, not your own. A measure never runs an eval. The OKR 进度 entry in `GLOSSARY.md` gives the `okr.toml` format. `okr --accept "<O>"` records the decision-maker's sign-off while that O is all met. `okr --json` lists under `attention` what the decision-maker must watch.
### Create
- `nawaban create <SPEC-ID> --title "<title>" --body-file <spec.md>` publishes a spec. A spec 票's body is the whole spec, and it stays unchanged.
- `nawaban create <SPEC-ID>-<NN> --title "<title>" --parent <SPEC-ID> --body-file <ticket.md> --blocked-by <票> --lane <name>` publishes a child 票. Its body has `## What to build` and `## Acceptance criteria`. Its title says what a person can see once it is done. A body can also be positional, or `-` to read it from stdin. The project follows `--parent`, then the repository you run in.
- Create blockers first. `nawaban block <票> <blocker>` adds an edge later. Both refuse unknown ids, a 票 that blocks itself, and cycles.
- `--lane <name>` labels the 票 `lane=<name>`. Give one lane to the 票 whose worker reads the same docs, changes the same directories and uses the same tools. The 票 in a lane run one after another in dependency order.
### Claim, release, close
- `nawaban claim <票>` makes the 票 yours. A 票 that another session holds is refused with the holder and its lease end. Wait for the release or the lease to run out, or have the orchestrator reassign it. A done or cancelled 票 is refused. `nawaban claim <票> --release` returns the 票 to the frontier, after you record a 进展同步.
- `nawaban close <票> --done` comes after the work merges and its `pr:` or `commit:` link is recorded. That merged link is the 完成标准. `close <票> --cancelled` drops the work and is never refused.
- A 票 closed by mistake cannot be reopened on the board. Upstream `nawaban board tasks reopen` refuses it with `Can't reopen task #<id>. It's finished.` Create a new 票, then point the old one at it with `nawaban event <old> note "重开为 <new>"`. A closed 票 still takes events.
### Record events
An event is `nawaban event <票> <kind> [body]`, and a body of `-` reads stdin.
```
nawaban event <票> note "已完成：<what is done> / 下一步：<next step> / 卡点：<what stops it, or 无>"
nawaban event <票> decision "决定：<what was chosen and why>
背景：<the question and the facts it turned on>
否决方案：<option>，<why not>
影响：<what follows, optional>"
nawaban event <票> link "pr:<url>"
```
- A note is the 进展同步. Record one at each stopping point and before a release.
- A decision is a 决策记录. Add `--by user` when the user made the choice. Add `--kr "<O / KR>"` when you decide on the owner's behalf and the choice moves a KR.
- Link prefixes are `pr:`, `commit:`, `artifact:` and `adr:`. A triage label is a note `triage: <label>`.
### KR impact declaration
- `nawaban claim <票> --o "<O>" --kr "<KR>=toward" --kr "<KR>=hold" [--change measure|gold]` declares as you claim, before the 票's first PR link. A declaration after the first PR link is 事后. It satisfies the close lock and is never judged or counted.
- `nawaban event <票> impact --o "<O>" --kr "<KR>=away"` declares later. Pure infrastructure and docs-only work declare `nawaban event <票> impact --o 无`. `--kr` takes `toward`, `away` or `hold` and repeats. The O and KR names must exist in this repository's `docs/agents/okr.toml`. `--change measure` or `--change gold` marks a change to the ruler, which is counted apart and not judged.
- `nawaban close <票> --done --kr "<KR>=95 实测" --kr "<KR>=83.3% 预计"` reports each registered KR's value after.
- In a repository with `okr.toml`, `close --done` is refused without a declaration, or with registered KRs and no result. A hook denies `gh pr merge` and `scripts/merge.sh <PR>` until every 票 the PR is for has a declaration: the 票 named in its title or branch, or after `Closes`/`Refs` in its body. A 票 the body only mentions in passing is not checked. Another hook denies a `gh` write whose token is not the repository's account: the `github-account: <account>` line in `docs/agents/issue-tracker.md`, else this machine's `~/.nawaban/github-accounts.json` entry for the origin owner (`{"<owner>": "<account>"}`); a repository with neither is left alone. Write it `GH_TOKEN=$(gh auth token --user <account>) gh …`.
### Ask the decision-maker
After each orchestrator reply the Stop hook shows the pending line, `待决 N 件：<new items>｜说「同步」看待决`. On the board it runs `nawaban status --line`. It counts only the tracker, so a question asked only in chat is not in it. To ask for a decision, put one `json#nawaban-ask-request@1` block at the top level of your reply. The ask-guard Stop hook records it as an `ask` on its 票, unless the 票 already waits on the owner. It sends the reply back when the block breaks the schema, a field says nothing, the 票 does not exist, or the ask cannot be recorded. A reply without the block goes through. To show the format without asking, put it in a four-backtick fence.
A session that is not the orchestrator records the ask itself with `nawaban event <票> ask "<决策事项>" --kr "<O / KR, or 无>" --context "<only the facts it turns on>" --option "<方案>｜<代价>｜单向门" --option "<方案>｜<代价>｜双向门" --rec "<which 方案 and why>"`. An ask meets the 就绪标准 when every field is present and none is a placeholder such as `无`, `none` or `-`. Only the KR may be `无`. Each option names its 代价 and its door. An ask that is 未就绪 is refused.
```json#nawaban-ask-request@1
{ "ticket": "NAWABAN-12", "decision": "详情页先上只读版，还是等编辑功能一起上", "kr": "O1 / 决策者每周拍板轮数", "context": "只读版今天能合；编辑还差两张票，预计周五",
  "options": [{ "choice": "先上只读版", "tradeoff": "多发一次版", "door": "two-way" }, { "choice": "等编辑一起上", "tradeoff": "晚三天拿到反馈", "door": "two-way" }], "recommendation": "先上只读版：能撤，早三天拿到反馈" }
```
### Waiting on the user
When the work needs the user to answer or act, ask in the conversation as usual and run `nawaban event <票> wait "<one-line question or what the user must do>"`. The 票 is held as 等你 (`needs_input`), and your claim ends. The Herdr panel and the pending line show it. When the user answers, `nawaban event <票> resolve "<their words>"` lifts the hold. The 票 goes back to the profile that waited, so only that profile's `claim` or `claim --ready` takes it. A wait that no profile raised returns the 票 to the pool. Do not write the old `triage: needs-info` note.
### What the web page writes
The web page never records a decision. `nawaban status --project <p>` ends with its two kinds of writes, each with its id and words. The UserPromptSubmit hook runs `status --project <p> --unseen <session>`, which prints only what that session has not seen yet.
- A 网页答复 is an answer on a held 票, and the hold stays. The pending line marks it `（网页已答）`. Check that it fits the question, then record `nawaban event <票> resolve "<words>"`, for a 待决 and a 等你 alike.
- A 收件箱条目 is an open message in `inbox/<project>`. Turn it into a 票 with `nawaban create <KEY> --title "<title>" --inbox <id>`, which takes the item's project and words and marks the item done. For a command or nothing, run `nawaban board label <id> inbox=done --if inbox=open`. Never use `board tasks create`, which leaves a 票 with no key that the board never shows.
### Dispatch
Run `nawaban dispatch <票> --brief "<goal, scope, what not to touch>" --accept "<checkable done, output to paste>" --check '<command>'`.
- Write the acceptance as `--check` commands whenever a command can prove it, one `--check` per command. They are noted on the 票 as `验收检查：`, printed in the brief, and `merge` runs them. A 票 with no `--check` keeps its acceptance as text, which only the worker's report vouches for.
- It refuses a closed 票. It cuts a worktree off `origin/main`, starts the worker there with `hc run --outlive-parent`, and records the terminal and the acceptance on the 票. While you dispatch, hold no 票 yourself.
- Reports go to the terminal labelled `role=orchestrator`, and with none alive nothing starts. The worker reports with `nawaban tell <票> "<one line>"`. With no orchestrator to reach, it notes `回报未送达：<line>` on the 票 and exits 0.
- On a 票 with a lane, `dispatch` assigns it to the profile of that lane's live worker and records a `派发 brief：` note. It sends that worker nothing. Only that profile can claim an assigned 票. When that worker has closed its window, run `nawaban board tasks assign <id> --pool`, then dispatch the 票 with `--new`.
- It starts a new worker instead when the lane has no live worker, when that worker runs another agent or model, or when a Claude worker has used half its context window. `--new` starts one anyway, for 票 in one lane that should run in parallel. `--to <terminal>` assigns the 票 to the worker in that live terminal.
- `nawaban claim --ready [--wait <d>] [--project <p>]` takes the next 票 assigned to you, else the oldest one in the pool, and prints the brief. Cut `wt/<key>` off the latest `origin/main` in the same worktree, and declare the KR impact first. With nothing ready it exits 1.
- In a GitHub-tracked repository, closing a 票 retires its dispatched worker once nothing else is open in its name and it sits idle: `close` does it at once, the orchestrator's Stop hook within a minute of an issue closed on GitHub. A worktree with uncommitted changes stays. Otherwise, to retire a worker without `merge`, wait until its 票 is closed and nothing is assigned to it, then run `hc kill <name>` and `git worktree remove <worktree>`. A hook refuses `hc kill` and `hc rm` while the terminal still holds an open 票. A worker whose window died still shows in `hc get <terminal> --json`. Resume it with `claude --resume <revive.session>` from its `cwd` in a new terminal.
### Merge
The worker that holds the 票 runs `nawaban merge <PR>` from its worktree once the pull request is open. It finds the 票 from the branch `wt/<key in lower case>`.
- Before it changes anything, it checks that your session holds the 票, the pull request is open, and the KR impact declaration is complete. Every check must pass, at least one must have run, and a head that carries `.github/workflows` needs a workflow run of its own. While a check runs or has not started, it prints what it waits for and exits 3, so run it again later.
- A pull request that changes more than `.md` files needs a comment line `<reviewer> review：无挡…` that names the current head commit in 7 or more characters. A push after the review needs a new review.
- On a 票 with `--check` commands, it runs them last, from the worktree, which must be clean and at the PR head. It releases the 票 and hands them to the board's native `tasks run`, followed by the squash-merge. Exit 0 merges and completes the 票, the only close it gets, so a 票 that registered KRs reports their results first with `merge <PR> --kr "<KR>=<after> 实测|预计"`, or merge refuses before it runs anything. A non-zero exit fails the 票 with `exited <code>` and leaves the pull request open. The tail of the output is noted on the 票. Fix it and rerun merge: it reopens the failed 票 and runs the checks again.
- Then it squash-merges with `--match-head-commit`, pulls the main checkout, and pulls `~/.nawaban/plugin` when that is this repository. A pull that changes a schema waits for the owner. It records the `pr:` link and closes the 票 as done.
- Last it claims the next 票 assigned to the worker's profile, never one from the pool, and looks for up to `--wait` (10m by default). In Claude Code, run it in the background. With nothing assigned, it removes the worktree and kills the terminal. Run from another terminal, it claims nothing and leaves the worker.
- A refusal or a failed step is noted on the 票 and sent to the orchestrator, and merge exits 1. Fix it and run merge again, and it carries on after the merge.
### Orchestrator
- You decide, plan and dispatch. You do not change repository files. In the `role=orchestrator` terminal, or the declared session outside Herdr, a PreToolUse hook refuses edits and shell writes, such as `git commit` or `sed -i`, to files inside a git repository. The board directory, the temporary directory and ignored files stay writable. Hand the change to a worker or a subagent, whose calls pass. Where the hooks do not run, dispatch the change anyway.
- Outside Herdr, `/nawaban:orchestrator` records the session as the project's orchestrator. Type it again after a new session id, such as after `/clear`.
- On Codex, declare with `$orchestrator`. The hooks run once you trust them in `/hooks`. Trust them again after a `codex plugin add` that changes the plugin, then restart the session. Start Codex with `codex --no-daemon` to have its terminal labelled in Herdr. The degraded rule, for Codex with untrusted hooks or an agent without hooks, is to run `nawaban status --project <p>` at the start of every turn and act on its 等你, 网页已答 and 收件箱. Do not run `status --line`, which Codex's sandbox refuses. Record every ask yourself before you ask.
- On Antigravity, declare with `/nawaban:orchestrator`. The pending line arrives as a system message at the start of each prompt. The degraded rule on Antigravity is to open your reply with that `待决 …` line, word for word. A reply that the ask guard sends back arrives as `Stop hook blocked termination:`. Fix the block it names and reply again. After you resume with `agy -c`, run `nawaban status --project <p>` once.
### Wayfinder maps
A wayfinder map is a parent 票 with a note `wayfinder: map`. Its body stays as first written, and its events carry the changes.
- A 票 on the map is `nawaban create <票> --parent <MAP>` plus a note `wayfinder: <type>`, with no `triage:` prefix. Its frontier is `nawaban list --parent <MAP> --frontier`.
- To resolve a 票, record its conclusion as a decision on it and a note `decided: <票> <title>: <one-line conclusion>` on the map, then close it as done. A research 票 first gets a link `commit:<sha on the research branch>`. An out-of-scope 票 instead gets `close --cancelled` and a map note `out-of-scope: …`.
- Fog that becomes a 票 gets a map note `graduated: <fog> → <票>`. To remove a 票, cancel it with a note that gives the reason.

## Repositories on the old CLI or GitHub
Here `nawaban` stands for `python3 <plugin root>/nawaban/cli.py --db <absolute board path>`. Write it out in full in every call, because a subagent's Bash refuses a command name kept in a shell variable. Pass the absolute `--db` from every worktree. It is the board that the project's `CLAUDE.md` or `docs/agents/issue-tracker.md` names, else `.nawaban/nawaban.db` in the main checkout. On GitHub, run the verbs on `'#N'` from that repository. The board section applies, with these differences.
- An event is `nawaban event <ID> --kind <kind> --body <body>`, where `<ID>` is a KEY or `'#N'`. A positional kind fails with `the following arguments are required: --kind`.
- There is no `--lane`, `--inbox`, `show --all`, `claim --ready`, `status`, `merge` or `tell`. `create` needs `--body-file <file>`. Verbs take `--help` but not `--json`, so JSON comes from `nawaban json task <ID>`, `nawaban json board` and `nawaban json okr`.
- There is no lease, so a held 票 stays held until its holder releases or closes it. There is no `wait`. On an old local board, write a note `triage: needs-info — 等你：<question>`, which `cli.py` shows under 等你.
- The index is `nawaban index`, which only `cli.py` has. As the orchestrator, run it at the start and after compaction. On GitHub it opens with the `## 待决` items, oldest first.
- `nawaban brief` works on GitHub only. For each 待决策项 it prints the issue, the text and the issue's last 3 进展. When the user says 同步, turn that material into 待决策项 yourself, and do not paste it as it is.
- KR impact is declared only by an event, such as `nawaban event '#N' --kind impact --o "<O>" --kr "<KR>=↑|↓|=[ <before>→<after> 实测|预计]"`. `claim` and `close` take no `--kr`, and there is no `--change`.
- On GitHub, `nawaban claim '#N'` assigns you and posts the claim. The kinds add `ask` and `resolve`. Each comment carries a marker that the readers trust, and the plugin's hook blocks a hand-written prefixed `gh issue comment`.
- An issue holds one 待决策项, so a second `ask` is refused until a `resolve`. The ask is `nawaban event '#N' --kind ask --body "<决策事项>"` with the same `--kr`, `--context`, `--option` and `--rec`. Relay the decision-maker's own call as `--kind decision --by user` on `'#N'`, or as a `resolve` of its 待决.
- `nawaban dispatch` always starts a new worker, and its brief has the worker report with `hc send <terminal>`. `close` also has a flag that reopens a 票 closed by mistake, which `nawaban close --help` names.
- `nawaban backup` copies the board into `backups/` beside it and prunes copies older than 14 days, so run it before risky changes. `nawaban init` creates an empty board, only when you connect a new project.
