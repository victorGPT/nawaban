# Historical Markdown tasks

The current source of truth and the setup steps are in [nawaban-setup](../../nawaban-setup/SKILL.md). Database-level gates come with the CLI; edit hooks are configured separately, and creating a database does not install them.

The Markdown track is retired and serves only to understand existing material. Old tasks usually sit in `.foreman/tasks/` or an archive directory the project declares; the frontmatter holds the status at that time and the body holds alignment notes and a timeline. The template is [TEMPLATE.md](../../nawaban-setup/TEMPLATE.md).

Read a historical task in its original meaning and infer no current database status from it. To import, first check the flags with `python3 "$NAWABAN_HOME/nawaban/import_md.py" --help`, then dry-run and verify on a temporary database; applying to the real database needs matching authorization. The retired `foreman_claim_check.py`, the Markdown done-gate, and moving task files by hand are not part of the current workflow.
