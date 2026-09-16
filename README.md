# nawaban

Before a building rises, the foreman stretches ropes on bare ground to mark the load-bearing axes: 地縄 (ji-nawa). An agent facing a chaotic request does the same: draws the lines. **Before the structure arises, draw the line.** / **在万物构筑之前,先拉绳定界。**

nawaban is a task coordination workspace for agents and people: tasks, ownership, dependencies, human asks, and delivery evidence share one board.

This initial repository preserves the existing runtime and skill verbatim. Its current CLI names, internal terminology, and installation paths remain unchanged; the bilingual [glossary](CONTEXT.md) defines the product vocabulary for subsequent changes. This snapshot is not yet a portable plugin installation.

| Path | Contents |
| --- | --- |
| `workos/` | Python CLI, SQLite runtime, board server, `board-up.sh`, and WebUI source |
| `skills/agent-foreman/` | Existing task coordination skill and references |
| `hooks/` | `foreman_branch_gate.sh`, `foreman_maintree_watch.sh`, and `foreman_session_start.py` |
| `workos/guard.py`, `workos/compile_gate_headless.sh` | The other two live hooks, preserved at their runtime paths |
| `tests/test_glossary.py` | CLI terminology coverage check |

Run the glossary check from this repository with an existing Python environment containing pytest:

```sh
python3 -m pytest -q tests/test_glossary.py
```

The test uses only the Python standard library and does not import or execute the runtime. Missing subcommands are named in the failure message.

Runtime data, logs, caches, installed dependencies, compiled WebUI output, the excluded DAG prototype and graph experiment, and the three retired hooks are omitted. No npm or pip distribution is introduced.

Licensed under the [MIT License](LICENSE).
