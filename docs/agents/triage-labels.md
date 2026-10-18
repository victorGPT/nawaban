# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

The nawaban board has no label field. To apply a label, record a note event on the card: `nawaban event <ID> --kind note --body "triage: <label>"` (`nawaban` as defined in `docs/agents/issue-tracker.md`). The latest `triage:` note is the card's current label. A card that is `open`, has no `triage:` note and has all its `depends_on` cards `done` counts as `ready-for-agent`.
