# Skill split evaluation

Researched on 2026-10-15 for NAWABAN-SKILL-SPLIT-RESEARCH-001, with Claude Code
2.1.299 on one macOS host. Question: would splitting the `nawaban` skills into
more single-purpose skills, like the set under `~/.agents/skills` (`tdd`,
`to-spec`, `to-tickets`, `domain-modeling`), load less text into a session?

Short answer: no. The references are already the on-demand tier, the main
skill body is smaller than the "small" skills it was compared with, and every
new skill adds a description to every session. Keep the current layout.

## How text gets into a session

Three tiers, each with a different cost:

| Tier | What | When it is paid |
|---|---|---|
| (a) listing | each skill's `name` + `description` | every session that has the plugin enabled, in any project, board or not |
| (b) body | `SKILL.md` below the frontmatter | once per `Skill` call |
| (c) reference | a file under `references/` (or `BOARD.md`, `TEMPLATE.md`) | only when the session reads that file |

A split can only save in (b) or (c), and it always costs in (a).

## Current files

Characters counted with Python `len()` on the files at this commit (most of the
text is Chinese, so characters, not bytes, are the useful unit).

### Skills

| Skill | Description chars | Body chars | Trigger (from its description) |
|---|---:|---:|---|
| `nawaban` | 81 | 2154 | before changing files, committing or branching in a repository with a board; not for reading or answering |
| `nawaban-director` | 90 | 3656 | this window is the director: split a request into cards, dispatch workers, read their letters, roll up acceptance |
| `nawaban-setup` | 55 | 1283 | connect nawaban to a project: database, Web, hooks |
| `nawaban-wrapup` | 45 | 675 | ending or handing off nawaban work: check this session's open claims |

Listing total: 271 description chars plus four names.

The `nawaban` body by section: frontmatter 226, 开始或续做 442, 认领与工位 439,
推进与完成 520, 按情况读取 484, 外部能力解析 189.

### References

| File | Chars | Read when (from the linking text) |
|---|---:|---|
| `nawaban/references/runtime.md` | 1420 | first use or a new project; linked from all four skills |
| `nawaban/references/director-worker.md` | 1442 | the session is a worker dispatched by a director |
| `nawaban/references/grill-protocol.md` | 886 | no card yet, splitting a goal, recording a decision; also from director |
| `nawaban/references/cards.md` | 1880 | before finishing: status, now, refs, handoff; also from wrapup |
| `nawaban/references/review-pr.md` | 912 | a PR is in scope or the project requires a separate review |
| `nawaban/references/gates.md` | 1212 | a claim warning, or a dependency/edit/archive was rejected; also from setup |
| `nawaban/references/locks.md` | 690 | a claim warning about paths held by another card |
| `nawaban/references/git-shared-tree.md` | 462 | extra PR commits or conflicts |
| `nawaban/references/skill-shelf.md` | 351 | an extra capability is needed |
| `nawaban/references/md-cards.md` | 465 | reading old Markdown cards |
| `nawaban-setup/BOARD.md` | 3160 | history track only, not for new facts |
| `nawaban-setup/TEMPLATE.md` | 2317 | history track only, not for new facts |

### The comparison set

`SKILL.md` chars in `~/.agents/skills`: `tdd` 3621, `to-spec` 3043,
`to-tickets` 5804, `domain-modeling` 3222. The `nawaban` file is 2300 chars
including frontmatter. The "small" skills are not smaller; they are separate
because they serve unrelated tasks, not because they were cut down for size.

## Measured

### Load cost in tokens

From this session's own transcript
(`~/.claude/projects/<worktree>/56d269a2-….jsonl`), the change in total input
tokens (`input` + `cache_creation` + `cache_read`) between consecutive
assistant turns:

- After `Skill nawaban:nawaban`: +1856 tokens. The tool result is the 2154-char
  body plus one "Base directory" line; the delta also holds the `Skill` call
  itself and the next turn's short text.
- After `cat references/director-worker.md` (1442 chars) plus an empty `echo`
  and the session id: +1416 tokens, again including the command and a short
  reply.

So for this text, one character costs a little under one token. One sample,
one session, so read it as an order of magnitude.

### How the skills are used

`python3 -I <job tmp>/skill_usage.py` scanned the main-session transcripts in
`~/.claude/projects` (490 files, 339 sessions, 2026-07-26 to 2026-10-14; the run
includes this session). It counts `Skill` tool calls and `Read`/`Bash` calls
whose path contains `nawaban/references/<file>`:

| Item | Calls | Sessions |
|---|---:|---:|
| `Skill nawaban:nawaban` | 99 | 70 |
| `Skill nawaban:nawaban-director` | 2 | 1 |
| `Skill nawaban-setup` / `nawaban-wrapup` | 0 | 0 |
| `runtime.md` | 89 | 55 |
| `director-worker.md` | 84 | 41 |
| `grill-protocol.md` | 31 | 20 |
| `cards.md` | 24 | 20 |
| `review-pr.md` | 23 | 15 |
| `gates.md` | 16 | 11 |
| `locks.md`, `skill-shelf.md` | 3 each | 3 each |
| `git-shared-tree.md`, `md-cards.md` | 1 each | 1 each |
| `BOARD.md` | 0 | 0 |
| `TEMPLATE.md` | 3 | 1 |

In the 70 sessions that loaded `nawaban`, a session read 2.09 distinct
reference files on average (median 2); 5 of 70 (7.1%) read none. One session
loaded both `nawaban` and `nawaban-director`. Subagent transcripts (820 files)
contained no `Skill` call for any nawaban skill.

Limits of this count: it sees only `Skill` tool calls, not a skill opened by a
typed slash command; reference reads under the old `foreman` paths are not
counted; sessions on other machines are not seen.

### Misfires

[skill-trigger-evaluation.md](skill-trigger-evaluation.md) is the only misfire
data. Across both rounds no should-not-load case ever loaded a nawaban skill
(54/54 train, 24/24 held out each time). Adding `nawaban-director` changed
nothing in that column. It did produce two kinds of wrong pick: one Opus run
loaded `nawaban-wrapup` where `nawaban` was expected, and Sonnet loaded no skill
in 2 of 24 director requests. Three runs per cell; these are small-sample
results.

## Options

Numbers in this section are derived from the measured sizes and counts above.
None of the options was run through the trigger evaluation.

### A. Keep the current layout

- (a) 271 description chars in every session.
- (b) 2154 chars per `nawaban` load.
- (c) about two references per session, chosen by the situation table. The two
  most read, `runtime.md` and `director-worker.md`, are about 1400 chars each.
- Misfires: measured above, none in the should-not-load cases.

### B. Turn the busiest references into their own skills

For example `nawaban-worker` from `director-worker.md`, `nawaban-pr` from
`review-pr.md`, `nawaban-grill` from `grill-protocol.md`.

- (a) Each new skill adds a description, 45–90 chars at today's lengths, to
  every session in every project, including the many with no board.
- (b)/(c) The same text is read, only through `Skill` instead of `Read`. Nothing
  is saved per use. `nawaban` still has to point to the new skill, so the
  situation table does not shrink.
- Misfires: more nawaban descriptions sharing the words card, PR, worker and
  review, and new competition with general skills that already own those words
  (`pr`, `code-review`, `grilling`). The director round showed that a fourth
  skill costs nothing in should-not-load cases but does produce wrong picks
  among the nawaban skills. Inference; not measured for these names.

### C. Split the `nawaban` body by phase

For example `nawaban-claim` (开始或续做 + 认领与工位, about 880 chars) and
`nawaban-finish` (推进与完成 + 按情况读取, about 1000 chars).

- (a) +1 description, the current one has to be reworded into two.
- (b) A session that edits files needs both halves: it claims, works and
  finishes. It would pay both bodies, a second frontmatter, a second `Skill`
  call, and the risk of loading only the first. The only sessions that would
  pay less are the ones that need one phase, and a read-only session already
  pays nothing because the description tells it not to load the skill.
- Misfires: two descriptions that both say "in a repository with a board".
  The evaluation showed loading `nawaban` first rose from 30/66 to 56/66 when the
  description was rewritten once; two descriptions split that wording. Inference.

### D. Fold `nawaban-wrapup` into a reference

Not a split, the opposite direction, included because the numbers point at it.

- (a) −45 description chars and one name in every session.
- (b) `nawaban` would link to a `wrapup.md` reference (675 chars) the same way
  it links to `cards.md` today.
- Usage: zero `Skill` calls for `nawaban-wrapup` in the 339 scanned sessions.
  `wrapup` is also a CLI verb, which the body already names.
- Misfires: removes the one measured wrong pick (`nawaban-wrapup` instead of
  `nawaban`). Risk: a "收尾 / 交接" request outside a working session would no
  longer find a nawaban skill by name. Inference; not measured.

`nawaban-setup` also has zero calls, but it is the only entry before a board
exists, so the same move does not apply to it.

## Conclusion

Measured:

- Sizes: the `nawaban` body is 2154 chars; the four descriptions are 271 chars
  together; the ten references are 351–1880 chars each. The compared small
  skills are 3043–5804 chars.
- Cost: one `Skill nawaban` load added about 1856 tokens, one 1442-char
  reference about 1416 tokens (one session).
- Use over 339 sessions: `nawaban` loaded in 70, `nawaban-director` in 1,
  `nawaban-setup` and `nawaban-wrapup` in none. A `nawaban` session reads about
  two references; 7.1% read none.
- Misfires in the existing evaluation: none in should-not-load cases; one
  wrong pick of `nawaban-wrapup`.

Inferred:

- Option B and C do not reduce what an editing session loads, and add to what
  every session loads. The per-use ceiling for any split is the 2154-char body,
  since references already load only on demand.
- More nawaban descriptions likely mean more wrong picks among nawaban skills,
  not more loads where none should happen.
- Option D would save about 50 chars per session and remove one known wrong
  pick. It is the only option that lowers the listing cost. Before adopting it,
  run it through `scripts/eval_skill_trigger.py` with a wrapup case added.

Recommendation: keep A. Consider D as a separate card with the trigger
evaluation as its acceptance check.
