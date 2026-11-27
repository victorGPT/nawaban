---
name: nawaban
description: The nawaban board is the issue tracker. Use when a skill says to publish a spec, "publish the tickets" or "fetch the ticket", or to find the frontier; before working on a ticket; and when recording a note, a decision between options, or a link such as a pull request.
---

# nawaban issue tracker

The board holds 票 and an append-only event log per 票. The engineering skills decide what to do, and the board records what was decided and done. Nouns are the Chinese terms in `GLOSSARY.md`.

Run `node <plugin root>/hooks/route.mjs` in the repository, with the plugin root two directories above this skill. It prints `board <project>`. A GitHub repository listed in `github-sync.json` works the same way: issue #N is the 票 `<PROJECT>-<N>`, and the board pushes its writes to GitHub. A session outside Codex, Antigravity, and Claude Code sets `NAWABAN_OWNER` to a stable name before it writes.

## Rules

- **Bring the user three kinds of question only:** how the product behaves, what is said to the outside, and whether something goes to production. Settle every other choice yourself. A step the running skill gives to the user, such as approving the split in `/to-tickets`, `grilling`, or a wayfinder HITL 票, still goes to the user.
- **Record every choice between options as a `decision` event,** the user's answers included.
- **Claim a 票 before you work on it.** Close or release it when you stop.

## Commands

`nawaban --help` lists the verbs, and `nawaban <verb> --help` lists each verb's flags. `<票>` is the KEY or the board number, with no `#`. Exit 0 is success, 1 a refusal, 2 a usage error, and 3 still waiting. `nawaban board <native verb>` runs an `@vercel/board` verb, such as `board label` or `board tasks assign`.

- `nawaban status` lists what needs attention: 等你, 停滞, 进行中, 待办. `nawaban show <票> --all` prints one 票 with every event.
- `nawaban list --frontier` lists every open 票 that no session holds and whose blockers are done or cancelled. A claim outside the frontier goes through, so check the frontier yourself.
- `nawaban okr` prints each KR's reading against its target. A measure never runs an eval. The OKR 进度 entry in `GLOSSARY.md` gives the `okr.toml` format. `okr --json` lists under `attention` what the decision-maker must watch.

## Create

- A spec 票's body is the whole spec, and it stays unchanged: `nawaban create <SPEC-ID> --title "<title>" --body-file <spec.md>`.
- A child 票 is `nawaban create <SPEC-ID>-<NN> --title "<title>" --parent <SPEC-ID> --body-file <ticket.md> --blocked-by <票> --lane <name>`. The [ticket skill](../ticket/SKILL.md) gives its body and title.
- Create blockers first. `nawaban block <票> <blocker>` adds an edge later.
- Give one lane to the 票 whose worker reads the same docs, changes the same directories, and uses the same tools. The 票 in a lane run one after another, in dependency order.

## Claim, release, close

- A 票 that another session holds refuses your claim until the release or the lease end. Have the orchestrator reassign it when you cannot wait.
- Record a 进展同步 before `nawaban claim <票> --release`.
- Run `nawaban close <票> --done` after the work merges and its `pr:` or `commit:` link is recorded. That merged link is the 完成标准.
- A board 票 closed by mistake cannot be reopened. Create a new 票 and point the old one at it: `nawaban event <old> note "重开为 <new>"`. An issue 票 pushed to GitHub reopens with `close --reopen`.

## Record events

An event is `nawaban event <票> <kind> [body]`. A body of `-` reads stdin.

```
nawaban event <票> note "已完成：<what is done> / 下一步：<next step> / 卡点：<what stops it, or 无>"
nawaban event <票> decision "决定：<what was chosen and why>
背景：<the question and the facts it turned on>
否决方案：<option>，<why not>
影响：<what follows, optional>"
nawaban event <票> link "pr:<url>"
```

- A note is the 进展同步. Record one at each stopping point.
- A decision is a 决策记录. Add `--by user` when the user chose. Add `--kr "<O / KR>"` when you decide on the owner's behalf and the choice moves a KR.
- Link prefixes are `pr:`, `commit:`, `artifact:`, and `adr:`. A triage label is a note `triage: <label>`.

## KR impact declaration

In a repository with `docs/agents/okr.toml`, declare the KR impact as you claim, before the 票's first PR link: `nawaban claim <票> --o "<O>" --kr "<KR>=toward"`. Docs-only and pure infrastructure work declare `--o 无`. A declaration after the first PR link counts as 事后, which is never judged or counted. `--change measure` or `--change gold` marks a change to the ruler, which is counted apart and not judged. Report each registered KR's value after with `--kr "<KR>=<after> 实测|预计"` on `close --done` or `merge`. The close lock and the merge hooks refuse a 票 without its declaration.

A `gh` write runs under the repository's GitHub account: `GH_TOKEN=$(gh auth token --user <account>) gh …`. The account is the `github-account:` line in `docs/agents/issue-tracker.md`, else the origin owner's entry in `~/.nawaban/github-accounts.json`.

## Ask and wait

- **A decision only the owner can make:** follow the [ask skill](../ask/SKILL.md).
- **An answer or an action you need from the user:** ask in the conversation, then run `nawaban event <票> wait "<one-line question or what the user must do>"`. The 票 is held as 等你, and your claim ends. When the user answers, record the conclusion with `nawaban event <票> resolve "<结论>"`. The 票 goes back to the profile that waited.

## Dispatch and merge

- The orchestrator runs `nawaban dispatch` as the [dispatch-route skill](../dispatch-route/SKILL.md) says. Reports go to the terminal labelled `role=orchestrator`.
- A worker reports with `nawaban tell <票> "<one line>"`. With no orchestrator to reach, it notes `回报未送达：<line>` on the 票.
- `nawaban claim --ready` takes the next 票 assigned to you, else the oldest one in the pool, and prints the brief. Cut `wt/<key>` off the latest `origin/main` in the same worktree.
- The worker that holds the 票 runs `nawaban merge <PR>` from its worktree once the pull request is open.
- A pull request that changes more than `.md` files needs a comment `<reviewer> review：无挡…` that names the head commit in 7 or more characters. A push after the review needs a new review.
- When `merge` exits 3, a check still runs. Rerun it later.
- When `merge` refuses, it notes why on the 票. Fix that and rerun.
- In Claude Code, run `merge` in the background. It waits up to `--wait` (10m) for the next assigned 票.
- To retire a worker without `merge`, wait until its 票 is closed and nothing is assigned to it, then run `hc kill <name>` and `git worktree remove <worktree>`. Resume a worker whose window died with `claude --resume <revive.session>` from its `cwd`, both read off `hc get <terminal> --json`.

## Wayfinder maps

A wayfinder map is a parent 票 with a note `wayfinder: map`. Its body stays as first written, and its events carry the changes.

- A 票 on the map is `nawaban create <票> --parent <MAP>` plus a note `wayfinder: <type>`. Its frontier is `nawaban list --parent <MAP> --frontier`.
- To resolve a 票, record its conclusion as a decision on it, add a map note `decided: <票> <title>: <one-line conclusion>`, and close it as done. A research 票 first gets a link `commit:<sha on the research branch>`. An out-of-scope 票 gets `close --cancelled` and a map note `out-of-scope: …`.
- Fog that becomes a 票 gets a map note `graduated: <fog> → <票>`. To remove a 票, cancel it with a note that gives the reason.
