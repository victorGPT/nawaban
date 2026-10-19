# Development

## Repository layout

The runtime and skill use the nawaban name; the bilingual [glossary](../GLOSSARY.md) defines the product vocabulary. The checkout ships as a Claude Code and Codex plugin.

| Path | Contents |
| --- | --- |
| `nawaban/` | Python CLI (`cli.py`, also `python -m nawaban`), board server, `board-up.sh`, and WebUI source |
| `skills/nawaban/` | The one skill: the issue-tracker guide for agents |
| `tests/test_glossary.py` | CLI terminology coverage check |

The plugin registers no hooks. Runtime data, logs, caches, and installed dependencies are omitted. The compiled WebUI in `nawaban/webui/dist` is committed so installs need no Node. No npm or pip distribution is introduced.

## Glossary check

Run the glossary check from this repository with an existing Python environment containing pytest:

```sh
python3 -m pytest -q tests/test_glossary.py
```

The test uses only the Python standard library and does not import or execute the runtime. Missing subcommands are named in the failure message.

## Verification

Run `uv run --no-project --python 3.12 --with pytest python -m pytest -q tests` after building the UI. Test configuration isolates local task data and credentials and supplies subprocess imports. PyYAML is optional: only the skill frontmatter check skips when it is absent. To cover it too, run `uv run --no-project --python 3.12 --with pytest --with pyyaml python tests/run.py`. Frontend checks are defined in `nawaban/webui/package.json`.

To rehearse the migration of an old board, run `nawaban migrate <old board> <new empty board>` against a copy; it never writes to the old file and refuses a target that already holds tasks.
