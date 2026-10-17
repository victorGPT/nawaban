# External capability catalogue

This project ships four skills: `nawaban`, `nawaban-director`, `nawaban-setup`, and `nawaban-wrapup`. Resolve every other skill from the current agent's enabled skills or tool catalogue, using the enabled name and its SKILL.md; never assume a global path on a personal machine exists.

Match capabilities to the task: interviewing or breakdown for requirement forks, modelling for structural changes, a prototype for interaction that cannot be judged statically, project verification for implementation and regressions, and independent review before delivery. An authorized, available native tool can do the equivalent. When a capability the project requires is missing, record it as a blocker; a missing optional skill does not block ordinary CLI, Web, or task work.

`scripts/skill_shelf.py` is an optional tool that inventories a personal skill directory. Its output depends on the caller's setup; it is not the project's fixed dependency list and not a portable installation check.
