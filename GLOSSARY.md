# nawaban

The shared language for tasks recorded by agents and read by people. English terms are authoritative; each Chinese line expresses the same concept, while current identifiers register the runtime vocabulary.

## Language

### Tasks

**Task**(任务)
A bounded unit of work with a title and a markdown body that holds what to build and its acceptance criteria. A spec is a task whose body is the whole spec.
任务是有标题和 markdown 正文的工作单元，正文写明要做什么和成功判据。spec 本身也是一个任务，正文就是整份 spec。
_Avoid_: ticket, card, issue, 票, 卡.
_Current identifiers_: `tasks`; CLI `create`, `show`, `list`.

**Body**(正文)
The markdown text of a task. By convention it has the sections "What to build" and "Acceptance criteria"; nothing enforces them.
正文是任务的 markdown 文本，约定分「What to build」和「Acceptance criteria」两节，不做强制检查。
_Avoid_: context, origin, success list as separate fields.
_Current identifiers_: `tasks.body`; CLI `create --body`, `create --body-file`.

**Acceptance criteria**(成功判据)
The section of a task's body that says when the task counts as done.
成功判据是任务正文里说明何时算完成的那一节。
_Avoid_: success, done gate.
_Current identifiers_: body heading `Acceptance criteria`.

**Project**(项目)
The repository a task belongs to. Several projects share one board and the board filters by project.
项目是任务所属的仓库。多个项目共用一张看板，看板可以按项目筛选。
_Avoid_: repo as a field name, workspace.
_Current identifiers_: `tasks.project`; CLI `create --project`, `list --project`.

**Parent**(父任务)
The task a task was split from, usually a spec. A child task without a project inherits its parent's project.
父任务是本任务拆分自的任务，通常是一份 spec。子任务不填项目时继承父任务的项目。
_Avoid_: epic, module, split-from edge.
_Current identifiers_: `tasks.parent`; CLI `create --parent`, `list --parent`.

**Blocked by**(被挡)
The tasks that must be done or cancelled before a task can start. The reverse relation is its dependents.
被挡是一个任务开工前必须完成或作废的那些任务；反过来看就是它的下游任务。
_Avoid_: depends on, waiting on, upstream gate.
_Current identifiers_: `blockers`; CLI `block`, `create --blocked-by`.

**Frontier**(可开工)
The open tasks that no session holds and whose blockers are all done or cancelled.
可开工是没有被会话认领、所有前置都已完成或作废的未关闭任务。
_Avoid_: ready queue, backlog.
_Current identifiers_: CLI `list --frontier`.

### Status and sessions

**Status**(状态)
A task is open, done or cancelled. Every status change is written to the event log.
任务状态只有未关闭、完成、作废三种，每次变化都自动记进事件流。
_Avoid_: claimed, staging-verified, waiting as statuses.
_Current identifiers_: `tasks.status` = `open`, `done`, `cancelled`; CLI `close`, `close --done`, `close --cancelled`, `close --reopen`.

**Unassigned**(待认领)
An open task that no session holds.
待认领是没有会话持有的未关闭任务。
_Avoid_: claimed, assigned.
_Current identifiers_: `tasks.status` = `open` with no `tasks.session`.

**In progress**(进行中)
An open task that a session holds. It is derived, never stored.
进行中是有会话持有的未关闭任务，由数据推导，不单独存储。
_Avoid_: in_progress as a stored status, doing.
_Current identifiers_: `in_progress` in `show`, `list` and board responses.

**Done**(完成)
A task closed because its acceptance criteria are met. Closing clears its session.
完成是成功判据满足后关闭的任务，关闭时清掉会话。
_Avoid_: merged, shipped as statuses.
_Current identifiers_: `tasks.status` = `done`; CLI `close --done`.

**Cancelled**(作废)
A task closed without being done. Closing clears its session.
作废是没有完成就关闭的任务，关闭时清掉会话。
_Avoid_: deleted, abandoned.
_Current identifiers_: `tasks.status` = `cancelled`; CLI `close --cancelled`.

**Session**(窗口)
The Claude Code or Codex session working on a task, identified from `CLAUDE_CODE_SESSION_ID`, then `NAWABAN_OWNER`.
窗口是正在做这个任务的 Claude Code 或 Codex 会话，身份依次取 `CLAUDE_CODE_SESSION_ID`、`NAWABAN_OWNER`。
_Avoid_: owner, worker, agent as the holder field.
_Current identifiers_: `tasks.session`; `CLAUDE_CODE_SESSION_ID`; `NAWABAN_OWNER`.

**Claim**(认领)
Setting a task's session. A claim on a task another session holds fails and names the holder, unless it is a takeover; releasing returns the task to the frontier.
认领是把任务的会话设成自己。别的会话已持有时认领失败并说出持有者，除非显式接手；交还后任务回到可开工列表。
_Avoid_: assign, start, lock.
_Current identifiers_: CLI `claim`, `claim --take`, `claim --release`.

### Events

**Event**(事件)
One append-only entry in a task's log, with a time, an author and a kind: note, status, decision or link.
事件是任务日志里只增不改的一条记录，带时间、作者和类别：note、status、decision、link。
_Avoid_: comment, history row.
_Current identifiers_: `events`; CLI `event`.

**Note**(备注)
A free-text event. The latest note is the task's current progress. A triage label is a note `triage: <label>`.
备注是自由文本事件。最新一条备注就是任务的当前进展；分诊标签记成 `triage: <label>` 备注。
_Avoid_: now, handoff, label field.
_Current identifiers_: `events.kind` = `note`; CLI `event --kind note`.

**Decision**(拍板)
An event recording a question, the verdict, the rejected options and who decided: the agent or the user.
拍板是记录问题、结论、被否方案以及由谁决定（agent 或用户）的事件。
_Avoid_: ask, approval, verdict as a separate record.
_Current identifiers_: `events.kind` = `decision`; CLI `event --kind decision`, `event --by user`.

**Link**(链接)
An event pointing at evidence: a pull request URL, an artifact path or an ADR number, optionally prefixed `pr:`, `artifact:` or `adr:`.
链接是指向证据的事件：PR 地址、产物路径或 ADR 编号，可加 `pr:`、`artifact:`、`adr:` 前缀。
_Avoid_: ref, merge_sha field.
_Current identifiers_: `events.kind` = `link`; CLI `event --kind link`.

### Board and data

**Board**(看板)
The one SQLite file that holds every task and event, and the read-only web page over it.
看板是存放全部任务和事件的那一个 SQLite 文件，以及它之上的只读网页。
_Avoid_: database as a product term, inbox, modules view.
_Current identifiers_: `.nawaban/nawaban.db`; `NAWABAN_DB`; CLI `init`; `nawaban/board_view.py`; `nawaban/board-up.sh`.

**Backup**(备份)
A timestamped copy of the board file under the board directory's `backups/`, kept for 14 days.
备份是看板文件带时间戳的副本，放在看板目录的 `backups/` 下，保留 14 天。
_Avoid_: source checkout as a backup of task data.
_Current identifiers_: CLI `backup`.

**Migration**(迁移)
Reading an old-schema board and writing its tasks and events into a new, empty board. The old file is never written and stays as the archive.
迁移是读取旧结构看板，把任务和事件写进一个新的空看板；旧文件从不被写入，留作存档。
_Avoid_: upgrade in place.
_Current identifiers_: CLI `migrate`.

### Interface messages

Exact display templates below are part of the English vocabulary. Braced names are interpolation slots; Chinese text preserves the existing interface. These entries govern display only, not stored enum values or user-authored task content.

| English | 中文 | _Avoid_ |
|---|---|---|
| Display | 显示 | Board display preferences; presentation only, never task mutation. |
| Sort by | 排序 | Board display preferences; presentation only, never task mutation. |
| Default order | 默认顺序 | Board display preferences; presentation only, never task mutation. |
| Recently updated | 最近更新 | Board display preferences; presentation only, never task mutation. |
| Recently created | 最近创建 | Board display preferences; presentation only, never task mutation. |
| Title (A–Z) | 标题顺序 | Board display preferences; presentation only, never task mutation. |
| Compact density | 紧凑密度 | Board display preferences; presentation only, never task mutation. |
| Visible fields | 显示字段 | Board display preferences; presentation only, never task mutation. |
| Board columns | 看板列 | Board display preferences; presentation only, never task mutation. |
| Hidden columns keep their tasks. The list still shows every matching task. | 收起列不会更改任务；列表仍显示全部符合筛选的任务。 | Board display preferences; presentation only, never task mutation. |
| Show all columns | 显示全部列 | Board display preferences; presentation only, never task mutation. |
| All board columns are hidden. | 所有看板列已收起。 | Board display preferences; presentation only, never task mutation. |
| Hidden columns: {count} · Restore them in Display | 已收起 {count} 列 · 可在「显示」中恢复 | Board display preferences; presentation only, never task mutation. |
| Refresh tasks | 刷新真实数据 | Board toolbar and synchronization status |
| Syncing… | 同步中… | Board toolbar and synchronization status |
| Synced at {time} | 同步于 {time} | Board toolbar and synchronization status |
| Refresh every {seconds} seconds | 每 {seconds} 秒刷新 | Board toolbar and synchronization status |
| Sync failed | 同步失败 | Board toolbar and synchronization status |
| Workspace | 工作区 | Runtime enum values as display labels or a different action sharing this label. |
| Filter | 筛选 | Narrows the task collection; never changes tasks. |
| Language | 语言 | Runtime enum values as display labels or a different action sharing this label. |
| Switch to Chinese | 切换到英文 | Runtime enum values as display labels or a different action sharing this label. |
| Loading… | 加载中… | Runtime enum values as display labels or a different action sharing this label. |
| Today | 今天 | Runtime enum values as display labels or a different action sharing this label. |
| Yesterday | 昨天 | Runtime enum values as display labels or a different action sharing this label. |
| This week | 本周 | Runtime enum values as display labels or a different action sharing this label. |
| Last week | 上周 | Runtime enum values as display labels or a different action sharing this label. |
| Last 7 days | 最近 7 天 | Runtime enum values as display labels or a different action sharing this label. |
| Start date | 起始日期 | A control label that describes an action different from what the control performs. |
| End date | 结束日期 | A control label that describes an action different from what the control performs. |
| Updated | 更新时间 | A control label that describes an action different from what the control performs. |
| Copy failed; select the text manually | 复制失败,手动选中吧 | A control label that describes an action different from what the control performs. |
| Cancel | 取消 | Runtime enum values as display labels or a different action sharing this label. |
| Just now | 刚刚 | Runtime enum values as display labels or a different action sharing this label. |
| Collapse | 收起 | Runtime enum values as display labels or a different action sharing this label. |
| Status | 状态 | Runtime enum values as display labels or a different action sharing this label. |
| Time | 时间 | Runtime enum values as display labels or a different action sharing this label. |
| Split from | 拆自 | Runtime enum values as display labels or a different action sharing this label. |
| Split out | 拆出 | Runtime enum values as display labels or a different action sharing this label. |
| Unblocks | 放开 | Runtime enum values as display labels or a different action sharing this label. |
| Properties | 属性 | Runtime enum values as display labels or a different action sharing this label. |
| {count} minutes ago | {count} 分钟前 | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} hours ago | {count} 小时前 | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} days ago | {count} 天前 | Dropped interpolation values or raw template placeholders in rendered text. |
| Copy {text} | 复制 {text} | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} more | 还有 {count} 条 | Dropped interpolation values or raw template placeholders in rendered text. |
| No {label} | 无 {label} | Dropped interpolation values or raw template placeholders in rendered text. |
| Created {time} | 创建 {time} | Dropped interpolation values or raw template placeholders in rendered text. |
| Close | 关闭 | Runtime enum values as display labels or a different action sharing this label. |
| No owner | 未认领 | Unassigned as the owner field label; this is not a lifecycle state. |
| EN | 中文 | Display text only; preserve stored values and user-authored content. |
| Main navigation | 主导航 | Display text only; preserve stored values and user-authored content. |
| Toggle sidebar | 切换侧栏 | Display text only; preserve stored values and user-authored content. |
| All projects | 全部项目 | Display text only; preserve stored values and user-authored content. |
| No project | 无项目 | Cards with a null or empty project; distinct from all projects. |
| Switch project | 切换项目 | Display text only; preserve stored values and user-authored content. |
| Agents advance tasks | 任务由 Agent 推进 | Display text only; preserve stored values and user-authored content. |
| Search tasks | 搜索任务 | Display text only; preserve stored values and user-authored content. |
| Search ID, title, owner… | 搜索编号、标题、负责人… | Display text only; preserve stored values and user-authored content. |
| List | 列表 | Display text only; preserve stored values and user-authored content. |
| {count} tasks | {count} 张任务 | Display text only; preserve stored values and user-authored content. |
| Task list | 任务列表 | Display text only; preserve stored values and user-authored content. |
| ID | 编号 | Display text only; preserve stored values and user-authored content. |
| Title | 标题 | Display text only; preserve stored values and user-authored content. |
| No matching tasks | 没有匹配的任务 | Display text only; preserve stored values and user-authored content. |
| All epics | 全部模块 | Display text only; preserve stored values and user-authored content. |
| Filter epics | 筛选工作模块 | Display text only; preserve stored values and user-authored content. |
| Loading tasks… | 正在读取任务… | Display text only; preserve stored values and user-authored content. |
| Custom updated date range | 自定义更新时间范围 | Display text only; preserve stored values and user-authored content. |
| Custom dates | 自定义日期 | Display text only; preserve stored values and user-authored content. |
| Clear filters | 清除筛选 | Display text only; preserve stored values and user-authored content. |
| View {id} {title} | 查看 {id} {title} | Display text only; preserve stored values and user-authored content. |
| Expand full text | 展开全文 | Display text only; preserve stored values and user-authored content. |
| Task details {id} | 任务详情 {id} | Display text only; preserve stored values and user-authored content. |
| Back | 返回 | Display text only; preserve stored values and user-authored content. |
| Current progress | 当前进展 | Display text only; preserve stored values and user-authored content. |
| Dismiss notification | 关闭通知 | Display text only; preserve stored values and user-authored content. |
| Failed to load | 加载失败 | Display text only; preserve stored values and user-authored content. |
| Switch to light mode | 切换浅色模式 | Display text only; preserve stored values and user-authored content. |
| Switch to dark mode | 切换深色模式 | Display text only; preserve stored values and user-authored content. |
| Theme | 主题 | Display text only; preserve stored values and user-authored content. |
| Light mode | 浅色模式 | Display text only; preserve stored values and user-authored content. |
| Dark mode | 深色模式 | Display text only; preserve stored values and user-authored content. |
| Date | 日期 | Display text only; preserve stored values and user-authored content. |
| Date range | 日期范围 | Display text only; preserve stored values and user-authored content. |
| Select date | 选择日期 | Display text only; preserve stored values and user-authored content. |
| Select date range | 选择日期范围 | Display text only; preserve stored values and user-authored content. |
| Apply | 应用 | Display text only; preserve stored values and user-authored content. |
| This month | 本月 | Display text only; preserve stored values and user-authored content. |
| Last month | 上月 | Display text only; preserve stored values and user-authored content. |
| This year | 今年 | Display text only; preserve stored values and user-authored content. |
| Last year | 去年 | Display text only; preserve stored values and user-authored content. |
| All time | 全部时间 | Display text only; preserve stored values and user-authored content. |
| {count} days selected | 已选 {count} 天 | Display text only; preserve stored values and user-authored content. |
| {count} day selected | 已选 {count} 天 | Display text only; preserve stored values and user-authored content. |
| No updates for {count} days | {count} 天没动静 | Days since an in-progress task's last event. |
| Reference | 引用 | Detail heading for link events; the term is Link. |
| Context | 来由 | Detail heading for the task body. |
| Decision log | 决策 | Detail heading for decision events; the term is Decision. |
| Activity | 活动 | Detail heading for the full event log in time order. |
| Notifications | 通知 | Toast region label; not a task message. |
