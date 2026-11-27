# Development

## Repository layout

The runtime and skill use the nawaban name; the bilingual [glossary](../GLOSSARY.md) defines the product vocabulary. The checkout ships as a Claude Code and Codex plugin.

| Path | Contents |
| --- | --- |
| `board/` | The board CLI and service (`src/cli.ts`) |
| `herdr/mods/nawaban-board/` | The Herdr panel |
| `skills/nawaban/` | The one skill: the issue-tracker guide for agents |
| `tests/test_glossary.py` | Board CLI verb coverage check |

The plugin registers all its hooks in `hooks/hooks.json`, `leader-index.sh` and `leader-gap.sh` included. Runtime data, logs, caches, and installed dependencies are omitted. No npm or pip distribution is introduced.

## Glossary check

Run the glossary check from this repository with an existing Python environment containing pytest:

```sh
python3 -m pytest -q tests/test_glossary.py
```

The test uses only the Python standard library and does not import or execute the runtime. Missing subcommands are named in the failure message.

## Verification

Run `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests` and `node --test herdr/mods/nawaban-board/logic.test.js`. Test configuration isolates local task data and credentials and supplies subprocess imports.
