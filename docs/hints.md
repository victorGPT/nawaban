# Optional hints on `create`

Both hints need `TYPESAFE_API_KEY`. Without it `create` behaves the same and prints no hint.

## Automatic modules

With `TYPESAFE_API_KEY` set, `create` without `--epic` asks for a module after the task has been committed. A confident answer fills the empty `epic` and records the score in a `meta` note on the task; `nawaban remodule` corrects a wrong one. An explicit module or a module inherited through `--split-from` skips the request.

The request uses TypeSafe Choice with all existing module names, up to three recent distinct task titles per module, and a “none” option. It sends the new title, the first 4,000 characters of its background, and up to ten success criteria (500 characters each). It uses one extra request, without retries. A unique module probability of at least 0.9 is required; missing credentials, unavailable or malformed responses, uncertainty, and empty catalogs leave the module empty. Boards with more than 254 modules skip the request to stay within the [255-option Choice limit](https://docs.typesafe.ai/primitives/choice).

See [the evaluation report](epic-hint-evaluation.md) for coverage, error rates, timing, and reproduction instructions. About one in six held-out answers above the threshold named the wrong module, so pass `--epic` when you already know it.

## Optional prerequisite suggestions

With `TYPESAFE_API_KEY` set, `create` can also suggest one unfinished prerequisite
after the new task commits. Candidates stay within the same project, prefer the
same module, then recent activity, and are capped at 25. A top Noul score of at
least 0.60 is required. The command only prints a suggestion; it never adds an edge.

Each prerequisite suggestion includes a shell-quoted command on the next line.
Paste it to add `link --kind depends_on -- <new-task> <prerequisite>`: the prerequisite
is upstream. The command uses the running Python interpreter, the installed CLI
file, and an explicit absolute `--db` path, so it targets the same board even from
another directory. Run it with the usual `NAWABAN_OWNER` or
`CLAUDE_CODE_SESSION_ID` identity environment, as required by `link`.
No prerequisite suggestion means no link command.

Title/success, module, and prerequisite suggestions share one five-second waiting
budget. Missing credentials, unavailable services, and uncertain or expired hint
stages stay silent and leave the created task intact; already-completed hints
remain visible. At the owner-selected, post-hoc
threshold, 22/120 cards received a hint: 13/22 matched a direct dependency and
20/22 matched an upstream dependency through the current graph. The closure
measure includes later-recorded edges and has mild temporal leakage;
see [the dependency evaluation](dependency-hint-evaluation.md) for request
success rates, false-hint rates, candidate recall ceilings, and limitations.
