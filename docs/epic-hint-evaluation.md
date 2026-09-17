# Module suggestion evaluation

Measured on 2026-09-17 against TypeSafe `jev-latest`, from one macOS host,
sequential requests with no retries. These are retrospective board-label
agreement results, not a human acceptance test or a guarantee of future accuracy.

## Dataset and leakage controls

The read-only board snapshot contained 847 tasks with nonempty, non-`n/a` stored
module labels across 69 modules. A fixed seed (`20260917`) selected 120 tasks
uniformly without replacement: 40 calibration tasks and 80 held-out tasks.
The held-out set covers 39 distinct modules. Labels are existing board
assignments, not labels invented by an evaluator.

Every request has all 69 module options plus `none`. Each module has up to three
recent distinct title examples; the evaluation excludes **all 120 sampled tasks
and matching titles** from examples. Module names remain in the candidate catalog,
including modules with no remaining examples. The request state contains only
the target title, background (first 4,000 characters), and up to ten success
criteria (500 characters each). Neither target ID nor expected module is sent
as a separate field. Existing background text can still mention module names or
related task IDs, as it can in normal use.

This is a frozen retrospective catalog, not a time-ordered simulation: related
tasks and later-created examples can exist. Historical labels can overlap or
contain synonyms; exact stored-label equality counts as a hit. Ungrouped cards
have no ground truth and are not scored. False suggestions on genuinely novel
modules therefore remain unmeasured. The 254-module boundary is tested locally;
live evaluation covers 69 modules only.

## Threshold and results

The unique top module must have probability **at least 0.9**. `none`, ties,
malformed answers, and lower scores produce no suggestion. The threshold was
selected on the calibration set and frozen before the held-out API calls.

| Split / threshold | Samples | Correct hints | Wrong hints | Silent | Hint precision | Correct / all | Wrong / all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Calibration / 0.7 | 40 | 13 | 5 | 22 | 72.22% | 32.50% | 12.50% |
| Calibration / 0.9 | 40 | 9 | 2 | 29 | 81.82% | 22.50% | 5.00% |
| **Held out / 0.9** | **80** | **21** | **4** | **55** | **84.00%** | **26.25%** | **5.00%** |

Held-out hint coverage is **25/80 = 31.25%**. The wrong-hint fraction among
displayed hints is **4/25 = 16.00%**. The overall hit rate, counting abstentions
as misses, is **21/80 = 26.25%**. Unthresholded top-choice accuracy on the same
held-out responses is 40/80 = 50.00%; the threshold trades coverage for fewer
wrong suggestions. Before this feature there were no module suggestions (zero
coverage, zero wrong suggestions); there is no existing semantic baseline.

All 120 requests returned answers. One calibration answer tied and was silent;
there were no unavailable answers. Initial calibration parsing rejected five
additional rounded probability distributions with totals of 0.99. The parser
now tolerates that observed rounding and was replayed against the saved raw
answers without new API calls. The change does not alter the 0.9 calibration
counts. The original responses and both summaries are retained privately.

Small sample sizes matter: four wrong suggestions are not a robust estimate
of the future error rate. This evaluation supports an optional hint only.

## Request size and latency

| Measurement | Calibration | Held out |
| --- | ---: | ---: |
| Candidate options per request | 70 | 70 |
| Maximum JSON request body | 32,396 bytes | 31,294 bytes |
| Median request duration | 0.667 s | 0.683 s |
| P95 request duration (nearest rank) | 0.764 s | 0.786 s |
| Maximum observed duration | 0.854 s | 1.218 s |

These durations measure the additional module API call, including HTTP response
reading, on this host/network. They exclude local catalog reads and the existing
title/success hint request. Module hints add at most one request and no retry;
the existing helper uses a 3-second socket timeout and a 5-second read deadline
checked after chunks. These are not a strict end-to-end CLI wall-clock bound
(DNS/connection and the other hint request are separate).

The runtime includes all modules when there are at most 254. With more than 254,
it silently skips the suggestion instead of selecting an arbitrary shortlist
or making multiple calls. The extra option is reserved for abstention, within
TypeSafe's [documented 255-option limit](https://docs.typesafe.ai/primitives/choice).

## Reproduce

Raw task content and responses remain in a private artifact directory linked
from the task board, outside the public repository. No API key or private task
texts are included in this report. Run with an existing `TYPESAFE_API_KEY`:

```sh
python3 scripts/eval_epic_hints.py --db /absolute/path/to/board.db --output /private/eval-output --split prepare
python3 scripts/eval_epic_hints.py --output /private/eval-output --split calibration
# Freeze _EPIC_HINT_THRESHOLD before looking at held-out responses.
python3 scripts/eval_epic_hints.py --output /private/eval-output --split holdout
# Optional offline re-scoring of the saved responses:
python3 scripts/eval_epic_hints.py --output /private/eval-output --split calibration --replay
```

Snapshot SHA-256: `8c50f3d8e547e8e6365602dd153c48180797a9ec1d819af0b10fe2c9b1772bbb`.
Question SHA-256: `d198ab5242fe45f92cf01205cfd58f4a544f0a3b1a6f78401a7c32625fff31a4`.
`jev-latest` is a floating model alias; a future run is not guaranteed to reproduce
these responses. The script refuses to replace raw responses for an existing
split. Replay changes summaries only and sends no API requests.

## Integration verification

`env -u TYPESAFE_API_KEY uv run --no-project --python 3.12 --with pytest python -m pytest -q tests`
passed all 118 tests. Coverage includes commit-before-request ordering, no module
write, explicit/inherited modules, missing credentials, API/network/read failures,
malformed and uncertain answers, threshold boundaries, and excessive catalogs.

A separate live CLI smoke test on a private synthetic two-module board returned
exit code 0, printed a one-line `BILLING` suggestion (0.95), and left the new
task's `epic` NULL. The whole command took 1.135 seconds on this host. That smoke
test verifies wiring only and is excluded from the 120-task evaluation. No
production installation or human acceptance is claimed.
