# Issue tracker: nawaban board

Specs and tickets for this repo live on the nawaban board, project `nawaban`. Use it through its CLI:

```
python3 /Users/victor/.nawaban/plugin/nawaban/cli.py --db /Users/victor/.nawaban/nawaban.db <verb> ...
```

Below, `nawaban` stands for that whole prefix. Always pass the absolute `--db` path above, also from worktrees. Write the whole command out in every call. Do not keep it in a shell variable (`N="python3 ..."; $N list`): a subagent's Bash refuses a command whose name is computed at runtime, and zsh does not split the variable. `nawaban <verb> --help` lists a verb's flags. Only the verbs below are part of this workflow.

## Conventions

- A card's ID is uppercase letters, digits and dashes, e.g. `LEAN` or `LEAN-03`.
- A card's `--title` says what a person can see once it is done.
- A card's body (`--context`) must be an unordered list, one `- ` line per point. Longer text goes into a file (see the spec below) and the body points to it.
- Acceptance criteria go into `--success` as a JSON array of strings, one observable result per item.
- Triage labels are note events, see `docs/agents/triage-labels.md`.

## When a skill says "publish the spec to the issue tracker"

1. Write the full spec markdown to `/Users/victor/.nawaban/specs/<SPEC-ID>.md` (create the directory if needed). It lives outside the repo so every worktree reads the same file; always refer to it by this absolute path.
2. Create the spec card:
   `nawaban create <SPEC-ID> --project nawaban --title "<title>" --context "- Full spec: /Users/victor/.nawaban/specs/<SPEC-ID>.md
- <one-line summary>"`

## When a skill says "publish the tickets"

Publish one card per ticket, blockers first:

1. `nawaban create <SPEC-ID>-<NN> --title "<title>" --split-from <SPEC-ID> --context "- <what to build, one point per line>" --success '["<criterion>", "..."]'`
2. For each blocker: `nawaban link <ticket> <blocking ticket> --kind depends_on`. A card cannot be claimed until every card it depends on is `done`.

Do not change the spec card when publishing tickets.

## When a skill says "fetch the relevant ticket" or "fetch the spec"

- `nawaban context <ID>` shows a card's body, acceptance criteria, status and history. For the spec, also read the file its body points to.
- `nawaban deps <ID>` shows what a card is blocked by, what it blocks, and the cards split from it. `nawaban deps <SPEC-ID>` lists all tickets of a spec.

## Frontier

The frontier is every ticket of the spec that is `open` and whose `depends_on` cards are all `done`. Find it with `nawaban deps <SPEC-ID>` and `nawaban context <ticket>`.

## Claiming and resolving a ticket

- Claim before work: `nawaban claim <ticket>`, then `nawaban start <ticket> --now "<what is being done>"`.
- Resolve once its work is merged into the integration branch: `nawaban ref <ticket> --kind merge_sha --value <merge commit sha>`, then `nawaban transition <ticket> --to done`. A ticket cannot be moved to `done` without a `merge_sha`.
- Notes and progress: `nawaban event <ticket> --kind note --body "<text>"`.
- A decision between options: `nawaban decide <ticket> --question "<question>" --verdict "<what was chosen and why>" --rejected '[{"option": "<option not chosen>", "reason": "<why not>"}]'`.

Tickets are resolved on the board. The integration branch reaches `main` through one pull request, which needs green CI.
