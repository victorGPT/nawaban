# Issue tracker: nawaban board

This repo's tickets are on the Vercel Board that `nawaban serve` keeps at `127.0.0.1:4100` (`~/.nawaban/board/`), project `nawaban`. Every call is written out in full as the `nawaban` command `install.sh` puts on PATH; run in this repository, `create` and `status` take project `nawaban` without `--project`:

```
nawaban <verb>
```

The old board, `/Users/victor/.nawaban/nawaban.db`, is no longer read or written; its open tickets were imported at the switch (NAWABAN-MIGRATE-06). A closed ticket's history from before then is in that file, readable with `sqlite3`.

GitHub writes (pushes, `gh pr create`, comments, merges) in this repository go out as this account; the token comes from this machine's `gh` keyring (`gh auth token --user victorGPT`), never from the repository:

github-account: victorGPT

How to use the board (rules, verbs, events, triage, wayfinder maps) is in the `nawaban` skill, [`skills/nawaban/SKILL.md`](../../skills/nawaban/SKILL.md).
