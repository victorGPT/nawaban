# Delivery and wrap-up

## Leave facts the next session can pick up

`status`, `now`, refs, and the latest handoff reflect the verified delivered version and runtime state. Record the actual commit, PR, or merge, the verification commands and their results, what is unfinished, and the next step. A project without a remote uses its local version; never assume an `origin/main`. Live configuration or human acceptance you did not check is marked unverified.

Keep long evidence in an accessible artifact and put a pointer on the task. Append decisions with `decide` and ordinary progress with `event`; look up fields and flags in the CLI help. Update ADRs or capability docs only when the project needs them and this change touches the behaviour they describe.

## Status and evidence

Pick the path from the user's and the project's completion conditions. A write accepted by a status gate is not acceptance of what was delivered.

| Situation | Record and action |
|---|---|
| Unmerged, or only files or a commit delivered | Save the artifact or commit ref; write the real progress with `handed_off` or `blocked`. The state machine has no path from an unmerged internal task straight to `done`. |
| Internal task actually merged under authorization and verified | Register the actual `merge_sha` ref, then transition from `in_progress` to `done`. |
| The project requires acceptance in the target runtime | After verifying, register `acceptance_run`, then move to `staging-verified`; choose `waiting_on` from the real dependency: `decision`, `prod`, `observe`, or `external`. |
| A human acceptance or decision is needed | Use an ask, as in the next section. |
| Still waiting on an observation window, an outside action, or a deploy | Keep the waiting state and the condition for the next check. Elapsed time or granted authorization is not evidence of the action or its effect. |

Example (replace the database, task ID, and SHA with verified values):

```bash
nawaban --db <target db> ref <ID> --kind merge_sha --value <actual merge SHA>
nawaban --db <target db> transition <ID> --to done
```

The CLI and the database validate legal transitions. `waiting_on` is not a freely editable field; a `staging-verified` task cannot switch its wait type through a same-state transition. Follow the rework or re-verification path the CLI allows and keep the original evidence.

## When the user must act

Keep doing work that existing authorization covers. Only when a required decision or authorization is missing, or the project requires human acceptance, build one specific question with `nawaban ask --help` and attach material the user can review.

- `decide`: at least two options, each with its consequence.
- `authorize`: the action to take, what it affects, and how failure is handled or rolled back.
- `accept`: positive evidence read from the target runtime. A merged PR or green CI does not replace it.

`answer` records the user's answer and carries only real user input. An `accept` answer may advance the task's status directly; an `authorize` or `decide` answer only records the decision and closes the ask, and `fanout --ok` runs only after the authorized action has actually succeeded. These multi-task operations commit task by task: on partial failure or an unknown result, check which decisions and statuses landed before recovering, and never assume the batch is atomic or safe to retry.

`decide --by user` is limited by the decision channel; setting the channel is not user authorization. A `decision` wait requires a valid user decision later than the latest acceptance time. If a same-second timestamp or a similar condition rejects it, check the original answer and its time; never invent a new answer to pass the gate.

## Record this attempt

```bash
nawaban --db <target db> handoff <ID> --outcome handed_off \
  --summary "<what was done, evidence, and remaining work>" --now "<current state and next step>"
```

- Choose the outcome that matches what happened. `completed` is only for `staging-verified` or `done`, and does not mean a human has accepted it; use `handed_off` while a merge or an action is still pending, and `blocked` for a specific blocker.
- A handoff ends this session's claim record and cannot run twice. When more work lands after it (a fix pushed after review), refresh the board with `nawaban event <ID> --body "<what changed>" --now "<current state>"`.
- A handoff does not advance the task to `done`. Add `--release` only to give up ownership: `claimed` and `in_progress` return to `open`, other statuses stay and lose their owner.
- After finishing the authorized work, check for leftovers with [nawaban-wrapup](../../nawaban-wrapup/SKILL.md). Restoring identity is covered in [Runtime and identity](runtime.md).
