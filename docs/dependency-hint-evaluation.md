# Dependency hint evaluation and integration

Measured on 2026-09-18 for NAWABAN-DEPHINT-012. The owner selected threshold
**0.60** after inspecting both corrected splits: 22/120 cards receive a top1 hint
(18.3% coverage), **13/22 match direct edges (59.1%)**, and **20/22 match upstream
dependencies through the current graph (90.9%)**. Cards without recorded
dependencies have 0/60 false hints. The CLI optionally prints one prerequisite
suggestion after committing a new task; it never writes an edge.

The owner explicitly replaced the original 0.75 direct-edge-only selection
because its coverage was only 4/120 (3.3%). This is a post-hoc product decision,
not a fresh independent holdout validation. Direct-edge precision at 0.60 does
**not** pass the original 80% direct-edge criterion; the final decision uses the
disclosed upstream/closure criterion. Both metrics are retained below.

The first unbounded-candidate experiment is superseded. It used an unsuitable
0.9+ threshold range and counted failed requests as missed labels. Its conclusion
was withdrawn following the director's verify event. Its private artifacts remain
intact; none of its 120 target cards occurs as a target in this corrected run.

## Dataset and local candidate narrowing

A SQLite `mode=ro` transaction captured 1,008 tasks, 218 `depends_on` edges, and
activity timestamps. Raw text and responses remain in a private directory linked
from the task board. No test cards were created in the live board.

For a historical target, eligible candidates are other tasks in the **same
project**, created no later than the target and not completed before it. Rank
eligible tasks by (1) same nonempty/non-`n/a` module first, (2) latest activity at
or before target creation, (3) latest creation, and (4) ID. Keep **at most 25**.
Activity is the latest creation or task-event timestamp available at that time;
future activity is excluded. Ranking never consults the answer edges.

Runtime uses the same ranking, but reads current unfinished candidates (`open`,
`claimed`, `in_progress`, `staging-verified`) and the committed task's project and
module, including an inherited module. A missing module simply removes the
same-module preference. Other projects, completed/cancelled tasks, and self are
excluded. Historic availability is approximate: current metadata and completion
timestamps cannot fully reconstruct cancellations, reopenings, or project edits.

After excluding cancelled targets and all 120 old targets, 73 eligible targets
had a recorded prerequisite and 738 had **no recorded outgoing dependency at
all**. Targets with recorded dependencies only outside the availability filter
were not counted as negative examples. Seed `20260919` selected 60 from each
pool: 20 positive + 20 negative calibration targets, and 40 + 40 held-out targets.
Targets do not overlap across splits. Candidate text and related tasks can still
overlap. The deliberately balanced sample does not represent natural prevalence.

The positive answer set contains all recorded direct prerequisites eligible
**before** the 25-candidate limit. Discarded true prerequisites remain in the
pruning denominator. Calibration retained 20/20 edges; holdout retained 49/49.
Both edge-recall ceilings and positive-card hit ceilings were 100%; zero true
prerequisites were discarded in these samples. This is a candidate-selection
ceiling, not model recall or a guarantee for future cards.

Current title/context/success and module values are used; historical versions
are unavailable and may contain later information. Some edges were recorded
later. “No dependency” means no **recorded** edge, not independent human proof.
False-hint rates below use the requested board-label convention; genuine missing
edges may count as false hints. These are retrospective label-agreement results,
not human acceptance evidence.

## Request, threshold selection, and denominators

One HTTP request asks a [TypeSafe Noul](https://docs.typesafe.ai/primitives/noul)
question for each shortlisted candidate. It asks whether the target directly
requires the candidate's result, distinguishing related, helpful, parallel, and
reverse work. Payloads include titles, up to 1,000 background characters, and up
to three success criteria of 300 characters each. IDs, modules, project, status,
and answer edges are not explicit model inputs; free text can still mention them.

The protocol lives in `nawaban/dependency_hints.py` and is shared by runtime and
evaluation. All 120 saved request hashes and parsed scores match the shared
implementation after extraction. Both summaries replay identically without API
calls. Responses are ranked by probability with ID as the tie-breaker. Only top1
is considered for display; showing one satisfies the card's “at most three” cap.

Before the new calls, thresholds **0.30 through 0.85 in steps of 0.05** and the
owner's **80% / 10% / 5 s** criteria were frozen. Among passing calibration
thresholds, selection maximizes correct top1 hints, then precision, then threshold.
There is no extra recall gate or minimum-hint-count requirement. Only 0.75 passed;
it was frozen before the original 80 held-out requests. After seeing both splits,
the owner selected 0.60 using the current graph's upstream closure, as documented
above. That later choice did not change or rerun the original requests.

A successful request has no transport error, a complete set of valid scores, and
finishes within five seconds. Request success rate uses **all requests**. Top1
precision, positive-card hit rate, coverage, and negative-card false-hint rate
use **successful requests only**. Failed requests are not silently counted as
misses. A successful positive card whose prerequisite was pruned can still be a
miss; that retrieval loss is separately exposed through the recall ceiling.
Undefined precision (no hints) does not satisfy the precision criterion.

## Final owner-selected threshold: 0.60

These metrics rescore the same 120 successful responses without new API calls.
The **direct** metric checks the recorded immediate prerequisites in the frozen
evaluation answer sets. The **closure** metric follows `depends_on` from the
target through all upstream tasks using a new read-only snapshot of the **current
board edges**. It includes edges added after target creation and therefore has
**mild temporal leakage**. It is an upstream-consistency measure, not proof of a
direct prerequisite or a leakage-free prospective prediction.

| Metric at 0.60 | Calibration | Original holdout | Combined |
| --- | ---: | ---: | ---: |
| Request success | 40/40 (100%) | 80/80 (100%) | 120/120 (100%) |
| Top1 hint coverage | 7/40 (17.5%) | 15/80 (18.75%) | 22/120 (18.3%) |
| Direct-edge hits / hints | 4/7 (57.1%) | 9/15 (60.0%) | **13/22 (59.1%)** |
| Closure hits / hints | 7/7 (100%) | 13/15 (86.7%) | **20/22 (90.9%)** |
| False hints on no-recorded-dependency cards | 0/20 (0%) | 0/40 (0%) | **0/60 (0%)** |
| Positive-card direct hit rate | 4/20 (20%) | 9/40 (22.5%) | 13/60 (21.7%) |
| Candidate direct-edge recall ceiling | 20/20 (100%) | 49/49 (100%) | 69/69 (100%) |
| True prerequisites discarded by cap25 | 0 | 0 | 0 |
| Request P50 / P95 / max | 0.932 / 1.305 / 1.675 s | 0.953 / 1.397 / 2.153 s | See per-split values |

The recall ceiling refers to known eligible direct edges before candidate
truncation. It has not been relabeled as closure recall. Error handling, candidate
rules, model prompts, top1-only output, read-only behavior, and the five-second
shared waiting budget remain unchanged. No model calls were repeated to improve
these results. Labels and timing limitations from the original study still apply.

## Original calibration selection: 0.75 (superseded)

Requested model: `jev-latest`; successful responses reported `jev-1.13.0`.
Requests were sequential on one macOS host with Python 3.14.7.

| Metric | Calibration | Holdout |
| --- | ---: | ---: |
| Successful requests / attempts | 40/40 (100%) | 80/80 (100%) |
| Positive / no-recorded-dependency cards | 20 / 20 | 40 / 40 |
| Top1 correct hints / hints (precision) | 1/1 (100%) | 3/3 (100%) |
| Positive-card hit rate | 1/20 (5%) | 3/40 (7.5%) |
| False hints on no-dependency cards | 0/20 (0%) | 0/40 (0%) |
| Hint coverage | 1/40 (2.5%) | 3/80 (3.75%) |
| True edges before / after narrowing | 20 / 20 | 49 / 49 |
| Discarded true edges | 0 | 0 |
| Candidate edge-recall ceiling | 100% | 100% |
| Positive cards retaining a true candidate | 20/20 (100%) | 40/40 (100%) |
| Candidate count min / median / max | 8 / 25 / 25 | 1 / 25 / 25 |
| Attempt duration P50 | 0.932 s | 0.953 s |
| Attempt duration P95 (nearest rank) | 1.305 s | 1.397 s |
| Maximum attempt duration | 1.675 s | 2.153 s |
| Maximum JSON payload bytes | 79,145 | 84,326 |
| Owner-specified evaluation gate | PASS | PASS |

Only **three** held-out hints support the reported 100% precision. Coverage is
low, and these counts do not establish a stable population accuracy. This limit
is disclosed without substituting a stricter gate for the owner's criteria.

The full calibration sweep is retained privately; selected rows show the tradeoff:

| Threshold | Correct / hints | Precision | No-dependency false-hint rate |
| --- | ---: | ---: | ---: |
| 0.30 | 8/18 | 44.4% | 5/20 (25%) |
| 0.50 | 5/9 | 55.6% | 0/20 (0%) |
| 0.70 | 2/4 | 50.0% | 0/20 (0%) |
| 0.75 | 1/1 | 100% | 0/20 (0%) |
| 0.80 and 0.85 | 0/0 | undefined | 0/20 (0%) |

## Runtime budget and failure boundary

The business task commits once before any advisory work. Title/success, module,
and dependency suggestions share a single advisory worker and a **4.5-second
wait**, reserving 500 ms within the five-second budget for scheduler wakeup,
return, and rendering.
The worker performs only reads and API calls. If it remains busy at the deadline,
the parent prints no late suggestions and returns success; a daemon worker cannot
keep the CLI process alive. It checks the deadline before starting another hint
request. An in-flight network call is not forcibly cancelled in an embedding
process, but cannot write task data or emit output after the timeout.

Missing credentials skip advisory work. Network errors, malformed/incomplete
scores, optional DB-read failures, low confidence, and empty candidate sets stay
silent. Explicit modules skip the module suggestion but still allow prerequisite
suggestions. There are no retries of API calls or the committed business write.

Evaluation duration includes request-subprocess startup, HTTP and response
reading/decoding, but not local candidate construction or existing hints. The CLI's
shared deadline additionally covers those advisory steps. The tests separately
exercise combined module/dependency delays and a network call stalled for 30
seconds, verifying that the CLI exits while retaining exactly one created card.
No production installation or human acceptance is claimed by this report.

Before the threshold-only update, `uv run --no-project --python 3.12 --with pytest
--with pyyaml python tests/run.py` passed all 33 inherited scripts and 286 pytest
tests; the frontend build also passed. A real API smoke on a private synthetic board printed
a prerequisite suggestion in 2.219 seconds, left `epic` NULL, and retained zero
edges. Missing credentials returned silently in 0.052 seconds. A separate stalled
network process exited successfully in 4.694 seconds with one committed task and
zero edges. The smoke cases are excluded from evaluation quality metrics.

## Reproduce

Use a fresh private output directory and an existing `TYPESAFE_API_KEY`:

```sh
python3 scripts/eval_dependency_hints.py --db /absolute/path/to/board.db --output /private/dependency-eval --exclude-snapshot /private/previous-eval/snapshot.json --split prepare
python3 scripts/eval_dependency_hints.py --output /private/dependency-eval --split calibration
python3 scripts/eval_dependency_hints.py --output /private/dependency-eval --split holdout
python3 scripts/eval_dependency_hints.py --output /private/dependency-eval --split holdout --replay
# Owner-selected threshold; freezes current edges privately, sends no API calls.
python3 scripts/eval_dependency_hints.py --output /private/dependency-eval --db /absolute/path/to/board.db --split rescore --threshold 0.60
```

`--exclude-snapshot` is optional for a first study. Raw splits and snapshots use
exclusive creation; rerunning does not replace evidence. HTTP failures retain
status/body privately. Replay sends no API requests and refuses incomplete splits.
The frozen model alias may resolve differently on a later date.

- Base commit: `e820a660c2ee42537c13e2e2e68e58d6bae7c901`.
- Corrected snapshot SHA-256: `73db3f8dfbe026f6e5d19eec66f39a05cac41a0d59590d79a11a2101e5605bc9`.
- Question SHA-256: `405acc18129db3c3e78070d249b92e0c44c779edc33c3982636b423590c7dadf`.
- Executed pre-extraction script SHA-256: `1bccce7f3cfb663820ba29be16537846023d2cc88ccef3b1d9b8649623166856`.
- Current-board closure edge snapshot SHA-256: `bc72a4d61d1b5f3020a9c896b5c42b3f5eae9d36695ea03a8a0f25b519e90a1f`.

The exact executed script, snapshot, raw responses, calibration decision, replay
summaries, and subsequent runtime checks are retained in private artifacts on
the task board. Public files contain aggregate results and reproducible code only.
