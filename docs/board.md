# Board: projects, task context and view preferences

## Projects on a shared board

Use `create --project <name>` to select a task's project when several repositories share one database. Without this option, a new task derives its project from the current repository's board directory, falling back to the explicit database's board directory; `--split-from` inherits the parent task's project. Project selection filters the board and inbox without changing the selected database.

For legacy cards, use `meta <task-id> --set-project <name>` to fill an empty project with an audit event. Existing projects cannot be overwritten; repeat attempts are rejected without another write. Back up a live board with `backup` before backfilling it. Select **No project** to find unassigned cards and their asks in the board, modules, and inbox. API reads use `?unassigned=1` for this filter; omitted or empty `project` still means all projects.

Task context supplied through `create --context` or `--context-file` must use a Markdown unordered list, with one point per item. This format is checked before the task is written. Existing records remain readable.

## Board view preferences / 看板显示偏好

Use **Filter / 筛选** for module, waiting reason, and updated-date filters; search stays in the toolbar.
Use **Display / 显示** for ordering, compact density, task ID/module fields, and visible board columns.
Hidden columns retain their tasks; the list layout continues to show all matching tasks. Restore columns
from Display, or use **Show all columns / 显示全部列** if every column is hidden.

Display preferences are stored locally (`nawaban.boardDisplay`) and in URL parameters
`boardColumns`, `boardSort`, `boardDensity`, and `boardFields`. Explicit URL values take precedence
over local values. Nonempty column or field preferences with no recognized IDs restore all columns or fields, respectively.
An empty `boardColumns=` hides every board column; an empty `boardFields=` hides
optional fields. Task titles and decision actions remain available. Preferences do not change task data.

「筛选」收纳模块、等待原因和更新日期；「显示」调整排序、密度、任务编号/模块字段和看板列。
收起列不会更改任务，列表仍展示全部符合筛选的任务。显示偏好同时保存到本地与 URL，URL 显式值优先。
