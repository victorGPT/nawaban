# Skill trigger evaluation

Measured on 2026-10-09 with Claude Code 2.1.295 in headless mode, from one macOS
host, on Sonnet 5.5 and Opus 5.5 (model names read from each run's result).
Three runs per case and model. These are small-sample behavioural results.

## Question

Does a session load the task skill before it starts changing files, and does it
stay away from the skill when the board is not involved? And does loading it
buy anything: fewer tool calls rejected by the gates?

## Method

`scripts/eval_skill_trigger.py` reuses the gate evaluation's throwaway repository
(one claimed, in-progress card) and loads exactly one plugin checkout per run,
with `NAWABAN_CONTEXT_BANNER=1` as in normal use. Each case is one request.

- 18 cases should load a nawaban skill. A run passes when the skill is loaded
  before the first `Edit`, `Write` or `Bash` call.
- 13 cases should not (reading a file, a language question that uses a word
  from the description). A run passes when no nawaban skill is loaded at all.
- Two read-only questions about board state are listed but not scored: the
  session banner already answers them, and sessions answered correctly without
  the skill.
- 11 cases (7 and 4) are held out by a fixed seed. Only train runs were read
  while choosing changes; the summary prints per-case rows for train only.

Every case was written by hand with a stated reason for being hard or plain.
None was chosen because a model failed it.

## Results

Each round changes one thing and is compared on the same cases.

- **v1**: the `nawaban` skill description now says to use it before changing
  files, committing or branching in a repository with a board, and that reading
  and answering questions do not need it.
- **v2**: v1 plus one sentence in the skill body: give shell writes an absolute
  path inside the worktree, because the write gate does not follow `cd`.

Both models pooled:

| Split | Variant | Runs | Should load: loaded first | Should not load: stayed out | Gate rejections |
|---|---|---:|---:|---:|---:|
| Train | base | 120 | 30/66 | 54/54 | 65 |
| Train | v1 | 120 | 56/66 | 54/54 | 52 |
| Train | v2 | 120 | 59/66 | 54/54 | 20 |
| Held out | base | 66 | 27/42 | 24/24 | 27 |
| Held out | v1 | 66 | 34/42 | 24/24 | 18 |
| Held out | v2 | 66 | 34/42 | 24/24 | 5 |

By model, should-load cases loaded first, base → v2: Opus 19/33 → 33/33 train
and 15/21 → 18/21 held out; Sonnet 11/33 → 26/33 train and 12/21 → 16/21 held
out. Mean nominal cost per run stayed within $0.02 of base for both models.

Both changes were kept: train and held-out scores moved the same way in each
round and no should-not-load case ever loaded a skill.

## Adding the director skill (2026-10-14)

A fourth skill, `nawaban-director`, was added for the window that splits a
request into cards and dispatches workers. The task skill's description was not
changed. Same cases, same method, Claude Code 2.1.296; `base` is the commit
before the skill was added and both variants ran in one interleaved batch.

| Split | Variant | Runs | Should load: loaded first | Should not load: stayed out | Gate rejections |
|---|---|---:|---:|---:|---:|
| Train | base | 120 | 61/66 | 54/54 | 11 |
| Train | new | 120 | 62/66 | 54/54 | 12 |
| Held out | base | 66 | 35/42 | 24/24 | 3 |
| Held out | new | 66 | 34/42 | 24/24 | 5 |

Pooled over both splits the count is 96/108 for both variants. The script counts
any skill whose name contains `nawaban`, so the transcripts were also read by
skill name: `nawaban` itself loaded first in 81 of 186 base runs and 80 of 186
new runs (the difference is one Opus run that loaded `nawaban-wrapup` instead),
and `nawaban-director` was never loaded in any of the 186 new runs.

Six further requests were run against the new variant only, three runs per
model, and scored by reading which skill loaded first:

- Four director requests (split and dispatch, read workers' letters, roll up
  acceptance, the same in English): `nawaban-director` first in 23/24 runs. The
  miss was Sonnet on "is this card ready to close", which loaded no skill in two
  of three runs.
- Two worker requests that mention the director: `nawaban` first in 12/12 runs,
  `nawaban-director` in none.

These differences are within the run-to-run noise of three runs per cell; they
show no loss, not a gain. The six extra requests were written after the skill
description and by the same person, and none of them dispatched a real worker.

## Reading

- Before the change, a request to edit a file went straight to `Edit`, was
  rejected by the write gate, and recovered through a worktree without touching
  the board. The work was done, but the card was not updated.
- Loading the skill was not enough. In v1, Opus loaded the skill in all 33 train
  runs and was still rejected 23 times, 20 of them by the write gate on a shell
  command. The sentence added in v2 removed most of those. The rejection count is the outcome; the load rate is the means.
- An earlier 16-case baseline with the context banner off had Sonnet loading
  the skill 3/3 on two resume cases where it loaded 0/3 with the banner on. The
  banner describes the card and never mentions the skill. The two baselines
  also differ in case list and state directory, so this is a lead, not a result.

## Limits

- Three runs per cell. The train gain is clear (Opus 46/60 → 60/60 correct, 95%
  intervals 0.65–0.86 and 0.94–1.00). The held-out gain in load rate is in the
  same direction for both models but its intervals overlap (27/42 → 34/42,
  0.49–0.77 and 0.67–0.90).
- The base runs finished about 20 minutes before v1 and 50 minutes before v2;
  the variants were not interleaved.
- One fixture: a single claimed card about a typo. Contention, a second session
  and real project size are not exercised.
- The cases were written by one person and not reviewed by a second.
- The child session keeps the host `HOME` so that it can authenticate. It can
  write there: one Sonnet case saved a memory file instead of recording a
  decision on the card, and each run left a project directory under
  `~/.claude/projects`.
- One Sonnet train case got worse in v1 and stayed there: recording a decision
  on a card (2/3 → 0/3). The new description stresses file changes.
- The merge gate, the largest source of rejections in real sessions, has no
  case here; the fixture has no remote.

## Reproduce

```sh
python3 scripts/eval_skill_trigger.py --variant base=<checkout> --variant new=<checkout> \
    --model sonnet --model opus --runs 3 --banner --output <dir outside the repository>
# Score saved transcripts again without calling a model:
python3 scripts/eval_skill_trigger.py --regrade <dir>/<run id>
```

Transcripts and per-run results stay outside the repository.
