# Issue tracker: nawaban board

This repo's tickets are on the Vercel Board that `nawaban serve` keeps at `127.0.0.1:4100` (`~/.nawaban/board/`), project `nawaban`. Every call is written out in full as the `nawaban` command `install.sh` puts on PATH; run in this repository, `create` and `status` take project `nawaban` without `--project`:

```
nawaban <verb>
```

Since the switch (NAWABAN-MIGRATE-06) the old board, `/Users/victor/.nawaban/nawaban.db`, is read-only for this project: `python3 /Users/victor/.nawaban/plugin/nawaban/cli.py --db /Users/victor/.nawaban/nawaban.db show <id>` still shows a closed ticket's history, and its write verbs say what to run on the board instead.

GitHub writes (pushes, `gh pr create`, comments, merges) in this repository go out as this account; the token comes from this machine's `gh` keyring (`gh auth token --user victorGPT`), never from the repository:

github-account: victorGPT

How to use the board (rules, verbs, events, triage, wayfinder maps) is in the `nawaban` skill, [`skills/nawaban/SKILL.md`](../../skills/nawaban/SKILL.md).
