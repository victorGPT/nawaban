---
name: nawaban-wrapup
description: Use when ending or handing off nawaban work. Checks this session's unfinished claims and records the real handoff state.
---

# nawaban wrap-up

Keep the CLI, target database, and session identity used for this work; when unsure, read [Runtime and identity](../nawaban/references/runtime.md). Resolve relative links from this skill's real path.

```bash
nawaban --db <absolute path of target db> wrapup
```

It lists this session's claim records that have not ended, not every active task, and it does not prove a task is done. When you took over from another session, or kept working after writing a handoff, also check the tasks this session actually handled.

Build a `handoff` from each task's real result: pick one outcome and fill in the summary and `now`. The CLI output is an illustrative template: it contains `|` placeholders and drops the explicit `--db`, so it cannot run as printed. When delivery or archive conditions still need checking, read [Delivery and wrap-up](../nawaban/references/cards.md).

```bash
nawaban --db <same absolute path of target db> handoff <ID> --outcome handed_off \
  --summary "<done, remaining, and evidence>" --now "<current state and next step>"
```

Add `--artifact <path that exists>` when an artifact was saved; add `--release` only when handing off and giving up ownership. A handoff records the attempt's result and does not set the task to done. Finish remaining work that authorization covers; when truly blocked, hand off as it is.

Done when: every task this session handled reflects its current state, artifacts are reachable, and unfinished items carry what the next session needs to pick them up.
