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
An open task whose latest `triage:` note is `triage: needs-info — 等你：<question>`: the agent needs the user to answer or act. It is derived, never stored; its session keeps holding it, and a later `triage:` note such as `triage: ready-for-agent` ends the wait. The Herdr panel shows these first, as cards, each with its question. It applies only when the board is the local nawaban board; when work is tracked on GitHub, a pending decision takes its place.
等你是最新一条 `triage:` 备注为 `triage: needs-info — 等你：<问题>` 的未关闭任务：agent 需要用户回答或动手。由数据推导，不单独存储；会话继续持有它，之后再记一条 `triage:` 备注（如 `triage: ready-for-agent`）就不再等。Herdr 面板把它们做成卡片放在最上面，并显示那句问题。它只用于 nawaban 本地看板模式；在 GitHub 上记账时改用待决。
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

### Objectives and decisions

**Objective**(目标)
A GitHub issue that names one outcome the user wants and how its progress is measured, by an intent and a metric at the top of its body. Objectives are one level deep: an objective has no parent objective.
目标是一张 GitHub issue，正文开头写明用户要的一个结果，以及用什么衡量进度：意图和度量。目标只有一层，不嵌套。
_Avoid_: goal, OKR, epic, milestone.
_Current identifiers_: issue body lines `意图：` and `度量：`; `json board` `objectives`, task `objective`.

**Intent**(意图)
The line of an objective that says which item of the roadmap it serves, with that item's number.
意图是目标里说明它服务于排期中哪一件事的那一行，带条目号。
_Avoid_: purpose, why, motivation.
_Current identifiers_: issue body line `意图：`.

**Metric**(度量)
The line of an objective that defines how progress is measured: the measure, what it means in plain words, the target value, and the current value with its date. When the value changes, the line is rewritten.
度量是目标里定义如何衡量进度的那一行：指标定义、人话换算、目标值，以及现值和日期。现值变了就改写这一行。
_Avoid_: KPI, reading, score.
_Current identifiers_: issue body line `度量：`.

**Decision brief**(决策简报)
The body of a pending decision: what the user needs to decide this without asking anyone, including why it came up, the options, the recommendation and the default action.
决策简报是待决的正文：用户不用追问就能拍板所需的全部内容，包括来龙去脉、选项、推荐和默认动作。
_Avoid_: ask, question, proposal.
_Current identifiers_: `json board` `pending.brief`.

**Pending decision**(待决)
An open issue in which the latest line starting `待决：` is followed by no line starting `已决：`. A line starting `需要你定：` counts as `待决：`. The lines may be in the body or in any comment. It is derived from the issue's text, never from a label. An issue holds at most one pending decision at a time.
待决是一张开着的 issue：最新一个以 `待决：` 开头的行之后，没有以 `已决：` 开头的行。旧写法 `需要你定：` 也算待决。这些行可以在正文里，也可以在评论里。由数据推出，不看标签。一张 issue 同时只挂一件待决。
_Avoid_: waiting on you (local board only), needs-info, blocked, D1-style numbering.
_Current identifiers_: line prefixes `待决：`, `需要你定：`; CLI `brief`; `json board` task `pending`.

**Resolution**(已决)
The line that ends a pending decision, recording the user's words or the outcome. Only a resolution ends one; a `决定：` line is still recorded but does not.
已决是结掉待决的那一行，记下用户原话或结论。只有它能结案；`决定：` 照常记账，但不结案。
_Avoid_: decided, answered, removing a label.
_Current identifiers_: line prefix `已决：`.

**Default action**(默认动作)
What happens to a pending decision if the user does not answer: either the recommendation is carried out at a stated time, or the decision can be left waiting. Only the first kind falls due, 8 hours after the decision was raised.
默认动作是用户不回答时这件待决怎么办：到写明的时间按推荐执行，或者可以搁置。只有写"按推荐执行"的，过 8 小时才算到期。
_Avoid_: timeout, auto-approve, fallback.
_Current identifiers_: brief field `【默认动作】`; `json board` `pending.default_action`, `pending.due`.

### Board and data

**Board**(看板)
The one SQLite file that holds every task and event.
看板是存放全部任务和事件的那一个 SQLite 文件。
_Avoid_: database as a product term, inbox, modules view.
_Current identifiers_: `.nawaban/nawaban.db`; `NAWABAN_DB`; CLI `init`, `json`.

**Index**(索引)
The md text a leader reads when it starts or after its context is compacted: the open work grouped as waiting on the user (the board only), stopped (no activity for 24 hours, with on whom) and moving, each with its spec, latest progress and next step; the user's decisions of the last 48 hours; the untouched; and a count of the closed. At the top come two sections, pending decisions and objectives; the other sections follow unchanged. It is printed from `json board`'s data each time and never stored.
索引是 leader 开工或上下文压缩后读的那份 md 文本：开着的事按等你（仅本地看板）、停了（24 小时没动静，写明停在谁身上）、在推分组，每件带所属的 spec、最新进展和下一步；48 小时内用户拍的板；没动的；关掉的个数。最上面加"待决"和"目标"两段，原有各段保留。每次从 `json board` 的数据现打，从不存。
_Avoid_: wiki, summary file, status report.
_Current identifiers_: CLI `index`; `NAWABAN_OWNER_NAMES`.

**Herdr panel**(Herdr 面板)
A read-only view of the board docked in a Herdr window beside the terminals, listing, for the project of the current space, what each leader and its workers are doing. At the top come two sections, pending decisions and objectives; the other sections follow unchanged. Claiming, closing and dispatching stay with agents and the CLI.
Herdr 面板是停靠在 Herdr 窗口终端旁的只读看板视图，按 leader 列出当前 space 所在项目里每个 leader 和它的 worker 在做什么。最上面加"待决"和"目标"两段，原有各段保留。认领、关闭、派活仍由 agent 通过 CLI 完成。
_Avoid_: sidebar, shepherdr, board tab.
_Current identifiers_: `herdr/mods/nawaban-board`; layout block `nawaban`; key `cmd-shift-j`.

**Backup**(备份)
A timestamped copy of the board file under the board directory's `backups/`, kept for 14 days.
备份是看板文件带时间戳的副本，放在看板目录的 `backups/` 下，保留 14 天。
_Avoid_: source checkout as a backup of task data.
_Current identifiers_: CLI `backup`.
