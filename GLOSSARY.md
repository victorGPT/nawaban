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

**Waiting on you**(等你)
An open task whose latest `triage:` note is `triage: needs-info — 等你：<question>`: the agent needs the user to answer or act. It is derived, never stored; its session keeps holding it, and a later `triage:` note such as `triage: ready-for-agent` ends the wait. The Herdr panel shows these first, as cards, each with its question.
等你是最新一条 `triage:` 备注为 `triage: needs-info — 等你：<问题>` 的未关闭任务：agent 需要用户回答或动手。由数据推导，不单独存储；会话继续持有它，之后再记一条 `triage:` 备注（如 `triage: ready-for-agent`）就不再等。Herdr 面板把它们做成卡片放在最上面，并显示那句问题。
_Avoid_: needs-info as a status, a stored question.
_Current identifiers_: `waiting` on open tasks in `json board` (the question, or null); panel window state `waiting`.

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
Setting a task's session. A claim on a task another session holds fails and names the holder, unless it is a takeover; releasing returns the task to the frontier. Inside Herdr a claim also records the terminal it ran in.
认领是把任务的会话设成自己。别的会话已持有时认领失败并说出持有者，除非显式接手；交还后任务回到可开工列表。在 Herdr 里认领还会记下所在终端。
_Avoid_: assign, start, lock.
_Current identifiers_: CLI `claim`, `claim --take`, `claim --release`.

**Leader**(leader)
The session the user talks to about a piece of work. It does tasks itself and starts worker sessions. In Herdr a leader is a terminal with child terminals (`parent` in `terminals()`, the tree in Herdr's sidebar), and its workers are those children, whatever tracker they work from. On the board, a task's leader is the author of its latest `dispatch:` note, else the session holding it, else the session that last claimed it; the panel uses that only for tasks no window holds yet.
leader 是用户就一摊工作直接对话的那个会话。它自己做一些任务，也开 worker 会话。在 Herdr 里，leader 是有子终端的终端（`terminals()` 的 `parent`，即 Herdr 侧边栏里的树），它的 worker 就是这些子终端，不管它们用哪个 tracker。在看板上，一个任务的 leader 是它最新一条 `dispatch:` note 的作者，没有时是持有它的会话，没人持有时是最后认领它的会话；面板只对还没有窗口在做的任务用这条。
_Avoid_: 总经理, lead agent, dispatcher, coordinator.
_Current identifiers_: note `dispatch: <worker name>` (agent-center also writes `coord: dispatch {…}`).

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
The one SQLite file that holds every task and event.
看板是存放全部任务和事件的那一个 SQLite 文件。
_Avoid_: database as a product term, inbox, modules view.
_Current identifiers_: `.nawaban/nawaban.db`; `NAWABAN_DB`; CLI `init`, `json`.

**Herdr panel**(Herdr 面板)
A read-only view of the board docked in a Herdr window beside the terminals, listing, for the project of the current space, what each leader and its workers are doing. Claiming, closing and dispatching stay with agents and the CLI.
Herdr 面板是停靠在 Herdr 窗口终端旁的只读看板视图，按 leader 列出当前 space 所在项目里每个 leader 和它的 worker 在做什么。认领、关闭、派活仍由 agent 通过 CLI 完成。
_Avoid_: sidebar, shepherdr, board tab.
_Current identifiers_: `herdr/mods/nawaban-board`; layout block `nawaban`; key `cmd-shift-j`.

**Backup**(备份)
A timestamped copy of the board file under the board directory's `backups/`, kept for 14 days.
备份是看板文件带时间戳的副本，放在看板目录的 `backups/` 下，保留 14 天。
_Avoid_: source checkout as a backup of task data.
_Current identifiers_: CLI `backup`.
