# Development

## Repository layout

The runtime and skills use the nawaban name. CLI subcommands and database schemas retain their existing contracts; the bilingual [glossary](../CONTEXT.md) defines the product vocabulary. The checkout ships as a Claude Code and Codex plugin.

| Path | Contents |
| --- | --- |
| `nawaban/` | Python CLI, SQLite runtime, board server, `board-up.sh`, and WebUI source |
| `skills/` | Task coordination (`nawaban`), project setup (`nawaban-setup`), and session handoff (`nawaban-wrapup`) skills |
| `hooks/` | `foreman_branch_gate.sh`, `foreman_maintree_watch.sh`, and `foreman_session_start.py` |
| `nawaban/guard.py`, `nawaban/compile_gate_headless.sh` | The other two live hooks, preserved at their runtime paths |
| `tests/test_glossary.py` | CLI terminology coverage check |

Runtime data, logs, caches, installed dependencies, compiled WebUI output, the excluded graph experiment, and the three retired hooks are omitted. No npm or pip distribution is introduced.

## Glossary check

Run the glossary check from this repository with an existing Python environment containing pytest:

```sh
python3 -m pytest -q tests/test_glossary.py
```

The test uses only the Python standard library and does not import or execute the runtime. Missing subcommands are named in the failure message.

## Verification

Run `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests` after building the UI. Test configuration isolates local task data and credentials and supplies subprocess imports. PyYAML is optional: only historical Markdown/YAML parsing tests skip when it is absent. To cover that optional path too, run `uv run --no-project --python 3.12 --with pytest --with pyyaml python tests/run.py`. Frontend checks are defined in `nawaban/webui/package.json`.

To verify an existing board without migrating it, run `python3 scripts/verify_database_copy.py /path/to/board.db`. It opens the source read-only, migrates a temporary backup twice, and verifies exact schema and row preservation plus integrity and foreign keys. A separate disposable copy exercises create, claim, the context detail API, and project filters.
