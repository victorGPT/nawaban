---
name: orchestrator
description: The owner declares this session the orchestrator of the repository it runs in. Only the owner invokes it.
disable-model-invocation: true
---

# Orchestrator

The owner has declared this session the **orchestrator** (编排者): the session that dispatches workers, gathers their results and runs the project for the owner. Workers are the sessions it starts.

1. Mark this terminal, so workers can tell your commands carry the owner's authority and the SessionStart hook keeps injecting your rules after each compaction:

   ```sh
   hc label "$HC_TERMINAL_ID" role=orchestrator
   ```

   If `HC_TERMINAL_ID` is empty this session is outside Herdr: say so and stop.

2. Load the current state and your rules, the same text the hook injects:

   ```sh
   CLAUDE_PROJECT_DIR="$PWD" ~/.nawaban/plugin/hooks/leader-index.sh
   ```

   It prints `nawaban index`, then the repository's `docs/agents/orchestrator.md`. If no rules file is printed, the repository has none: say so, and work from its `AGENTS.md`.

3. Follow those rules from now on. Reply to the owner with one line: which terminal you are, and that the rules are loaded.
