---
name: nawaban-setup
description: Connect nawaban to a project, setting up its task database, the Web board, and the hooks it needs; for day-to-day tasks on an existing board, use nawaban.
metadata:
  version: "3.0.0"
---

# Connecting nawaban to a project

Done when: the target project uses one explicitly named task database, the CLI and Web entry points it needs run, and only integrations actually wired and verified are reported as active.

## Connect the target project

First confirm the project to connect, any existing task database, and the entry points needed. Reuse an existing installation and database. When the installation is missing, follow [Install and integration](../../README.md#install-as-a-plugin); CLI, data addressing, and identity conventions are in [Runtime and identity](../nawaban/references/runtime.md). Resolve relative links from this skill's real path.

Create a new board in the target project's shared main checkout:

```bash
nawaban --db <target project main checkout>/.nawaban/nawaban.db init
```

Point at an existing board directly. Migrating existing data is a separate data operation and needs authorization covering the migration, a backup, and a recovery plan. Keep `.nawaban/` and the legacy `.foreman/` local and private; in a Git project, find the local exclude file with `git rev-parse --git-path info/exclude` and add the missing exclude rules.

When the user wants the Web board, start `python3 "$NAWABAN_HOME/nawaban/board_view.py" --db <absolute path of target db>` on an available port. Confirm the home page and the task API you open belong to this project. The Web board listens on localhost by default, and access includes inbox actions; access from other devices needs an explicit trust boundary.

## Connect only the integrations needed

- When agent skills are needed, enable the plugin's four skills (`nawaban`, `nawaban-director`, `nawaban-setup`, `nawaban-wrapup`) as the install notes say; a manual setup keeps the relative resource paths between their directories.
- When edit and branch constraints are needed, read [Claude Code and Codex hooks](../../README.md#install-as-a-plugin). Database-level status checks come with the CLI; edit and branch protection depends on hooks actually installed. Use the [gate table](../nawaban/references/gates.md) to troubleshoot.
- Configure Herdr, GitHub, CI, and deploy helpers as the project needs; connecting nawaban does not enable them and does not authorize outside messages or deploys.
- Read the [historical track notes](../nawaban/references/md-cards.md) only when reading old Markdown tasks; [TEMPLATE.md](TEMPLATE.md) and [BOARD.md](BOARD.md) are not for recording current facts.

## Verify, then deliver

Rehearse writes on a temporary database with a test identity; check the target's existing database read-only. SessionStart reclaims tasks as a side effect, so never smoke-test it on the real database.

Report the entry points connected, the target database, what was actually verified, and the remaining dependencies. Connecting a new project does not call for inventing business tasks; when the user already has work to do, create or claim a task with [nawaban](../nawaban/SKILL.md).
