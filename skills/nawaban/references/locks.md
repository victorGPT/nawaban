# Overlap coordination

A `touches` conflict at `claim` is a WARN, not a mutex and not edit authorization. Parallel work on the same path may conflict at merge time; check the other task, its worktree, and its real progress, and agree on an order. A failed liveness probe or a closed window does not prove the other work is finished.

To run the optional checker on its own, pass the target project's shared main checkout:

```bash
python3 "$NAWABAN_HOME/nawaban/claim_check.py" <target file> --owner <this session's owner> --repo <shared main checkout>
```

The helper reads `--repo/.nawaban/nawaban.db` (falling back to the old board when the new database is missing) and does not accept the CLI's `--db`. With a custom database or across projects, query the actual target board; the helper finding no overlap says nothing about another database.

## Changing scope

Record an authorized scope expansion on the board before editing:

```bash
nawaban --db <target db> scope <ID> --add <path> --reason "<why the expansion is authorized>"
```

Before narrowing stale `touches`, check the task's status, the version actually delivered, and the diff of those files in the other worktree, and follow the project's coordination rules; keep unknown work in progress. The command is:

```bash
nawaban --db <target db> release <ID> --drop <path> --reason "<verified reason to narrow>"
```

`release` only narrows `touches`; it does not release the owner. Pass ownership with `handoff --release`, described in [Delivery and wrap-up](cards.md). The tool allowing a change does not mean you are authorized to change someone else's scope.
