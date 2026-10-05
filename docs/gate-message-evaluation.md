# Gate message evaluation

Measured on 2026-10-05 with Claude Code 2.1.289 in headless mode, from one macOS
host. Each run is one session on a throwaway repository with its own board. These
are small-sample behavioural results (three runs per cell), enough to show
direction and not small differences.

## Question

Do the gates still earn their cost on stronger models, or do they only add steps
and tokens? Three plugin checkouts answered it:

- **old**: `9d8eb1c`, unchanged.
- **new**: the same gates with shorter rejection messages (worktree gate 506 → 346
  characters as delivered to the model, branch gate 683 → 361, title gate
  300 → 210), two sentences in the skill references that repeat a database
  rejection removed, and stale pointers fixed. No gate decision changed.
- **nohook**: `9d8eb1c` with the `PreToolUse` hooks removed, so only the skill
  text and the session banner describe the shared main tree.

## Method

`scripts/eval_gates.py` builds a repository with one claimed, in-progress card,
then runs `claude -p` with `--setting-sources project`, `--strict-mcp-config` and
one `--plugin-dir`, so user settings, user hooks and other plugins do not load.
The session ID matches the claim. A run passes when the end state is the one the
gate protects: the change is committed on a non-main branch and the main tree is
clean, the card exists, the handoff event exists, or the card is not marked done
without a merge.

Six scenarios: edit a file in the main tree, open a branch in the main tree,
create a card with a code-like title, hand off unfinished work, and two held out
from any tuning loop (append to a file with a shell redirect, mark an unmerged
card done). Models: Sonnet 5.5 and Opus 5.5.

## Results

Old against new, 72 runs:

| Model | Variant | Passed | Tool calls | Gate rejections | Output tokens | Cost per run |
|---|---|---|---|---|---|---|
| Sonnet | old | 17/18 | 5.6 | 1.2 | 1415 | $0.080 |
| Sonnet | new | 17/18 | 5.3 | 1.3 | 1431 | $0.078 |
| Opus | old | 18/18 | 7.0 | 0.8 | 2199 | $0.185 |
| Opus | new | 18/18 | 7.6 | 0.7 | 2386 | $0.193 |

The two versions are indistinguishable. The standard deviation of output tokens
within a variant (340 to 1006) is several times the difference between variants,
and a few hundred characters of message are invisible next to roughly 120k to
180k input tokens per run. Shorter messages did not hurt recovery either.

Without the write and branch gates, 18 runs on the three main-tree scenarios:

| Model | Passed | Runs that loaded the skill |
|---|---|---|
| Sonnet | 0/9 | 0/9 |
| Opus | 6/9 | 5/9 |

All five runs that loaded the skill passed; one of the thirteen that did not load
it passed. The failures were sessions that never saw the rule, not sessions that
ignored it. With the gates in place the same scenarios passed 35/36.

## The cost that did show up

In the old-against-new runs the worktree gate rejected 49 commands. 25 of them
(14 Sonnet, 11 Opus, in 21 of 72 runs) were writes inside the card's worktree: the
command changed directory into the worktree and then wrote a relative path, and
the Bash tripwire resolved that path against the session directory in the main
tree. Both failed runs are this case: the session did the right thing three times
and gave up. It reproduces without a model:

```bash
echo '{"session_id":"x","tool_name":"Bash","cwd":"<main tree with a board>",
  "tool_input":{"command":"cd .claude/worktrees/t && echo x >> NOTES.md"}}' \
  | NAWABAN_OWNER=o python3 nawaban/guard.py; echo $?   # prints 2, expected 0
```

## Reading

- Wording is not where the cost is. Tuning messages against this harness would be
  fitting noise, so no optimisation loop was run.
- The gates that protect shared state carry information a session cannot infer,
  and they deliver it at the moment of the mistake. That does not depend on the
  model being weak.
- The measurable waste is a gate rejecting correct work. About half of the
  worktree gate's rejections here were of that kind.

## Limits

- Three runs per cell, one host, one day. No confidence intervals are claimed.
- The scenarios are single-step and the fixture has no second session, so
  contention itself is not exercised, only whether the session avoids the main tree.
- The installed plugin on the measuring host was older than `9d8eb1c`; it was not
  loaded and is not the baseline.
- Database-level gates were exercised only by the title, handoff and done
  scenarios. The claim gates and the headless stop gate were not measured.
- Rejections by hooks are not logged in normal use, so there is no field data to
  compare these rates with.
