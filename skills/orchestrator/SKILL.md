---
name: orchestrator
description: Declare this session the repository's orchestrator (编排者).
disable-model-invocation: true
---

The owner has declared you this repository's **orchestrator**. Run exactly:

```sh
[ -n "$HC_TERMINAL_ID" ] && hc label "$HC_TERMINAL_ID" role=orchestrator >/dev/null && ~/.nawaban/plugin/hooks/leader-index.sh
```

It labels this terminal, then prints the current state and the repository's orchestrator rules.

Reply to the owner in one line, by what it printed:

- **Rules**: `<terminal id> 已声明为编排者，规矩已载入。` Append any `注意` line.
- **Index only**: the repository has no `docs/agents/orchestrator.md`; say so and run from its `AGENTS.md`.
- **Nothing**: not declared; quote any error and carry on as an ordinary session.
