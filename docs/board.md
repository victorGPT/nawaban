# Board: projects and view preferences

## Projects on a shared board

Several repositories can share one board file. `create --project <name>` sets a task's project. Without it, a task with `--parent` takes the parent's project; otherwise it takes the repository of the board directory the command runs in, falling back to the directory that holds `--db`. Select a project in the board to see only its tasks; **No project** shows tasks without one. API reads use `?unassigned=1` for that filter; an omitted or empty `project` means all projects.

## Board view preferences / 看板显示偏好

Use **Filter / 筛选** for the updated-date filter; search stays in the toolbar.
Use **Display / 显示** for ordering, compact density, the task ID and project fields, and visible board columns.
Hidden columns keep their tasks; the list layout still shows every matching task. Restore columns
from Display, or use **Show all columns / 显示全部列** if every column is hidden.

Display preferences are stored locally (`nawaban.boardDisplay`) and in URL parameters
`boardColumns`, `boardSort`, `boardDensity`, and `boardFields`. Explicit URL values take precedence
over local values. Nonempty column or field preferences with no recognized IDs restore all columns or fields, respectively.
An empty `boardColumns=` hides every board column; an empty `boardFields=` hides
optional fields. Task titles stay visible. Preferences never change task data; the board is read-only.

「筛选」收纳更新日期；「显示」调整排序、密度、任务编号/项目字段和看板列。
收起列不会更改任务，列表仍展示全部符合筛选的任务。显示偏好同时保存到本地与 URL，URL 显式值优先。
