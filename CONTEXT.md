# nawaban

The shared language for task coordination between agents and people. English terms are authoritative; each Chinese line expresses the same concept, while current identifiers register the runtime vocabulary.

## Language

### Tasks and lifecycle

**Task**(任务)
A bounded unit of work with an intended outcome, acceptance criteria, constraints, and an accountable owner when assigned.
任务是具有预期结果、成功判据和约束的工作单元，认领后由明确的负责人承担。
_Avoid_: ticket, card, 票, 卡.
_Current identifiers_: `tasks`; CLI `create`, `retitle`.

**Unassigned**(待认领)
A task available for assignment, subject to its unresolved dependencies.
待认领是尚待负责人认领的任务状态，能否开工仍取决于依赖。
_Avoid_: open, ready-for-agent, 未认领 as an alternative status label.
_Current identifiers_: `tasks.status` = `open`.

**Assigned**(已认领)
A task with an owner whose work has not yet started.
已认领是已有负责人、尚未开工的任务状态。
_Avoid_: claimed as the English display label.
_Current identifiers_: `tasks.status` = `claimed`.

**In progress**(进行中)
A task whose work has started and has not yet reached its delivery boundary.
进行中是已经开工、尚未到达交付边界的任务状态。
_Avoid_: in_progress, doing as display labels.
_Current identifiers_: `tasks.status` = `in_progress`.

**Ready for acceptance**(待验收)
A task with delivery evidence that is awaiting the stated acceptance, deployment, observation, or external follow-through.
待验收是已有交付证据、仍等待指定验收、上线、观察或外部后续动作的任务状态。
_Avoid_: staging-verified, 验收队列 as alternative status labels.
_Current identifiers_: `tasks.status` = `staging-verified`; `tasks.waiting_on`.

**Done**(完成)
A task whose required completion conditions have been satisfied and whose lifecycle is closed.
完成是已满足所需完成条件并结束生命周期的任务状态。
_Avoid_: merged, completed session, 最近完成 as synonyms for the status itself.
_Current identifiers_: `tasks.status` = `done`; `tasks.completed_at`.

**Cancelled**(作废)
A task closed because its premise no longer applies, rather than because its outcome was delivered.
作废是因前提不再成立而关闭、并非交付结果已完成的任务状态。
_Avoid_: done, deleted task.
_Current identifiers_: `tasks.status` = `cancelled`; CLI `cancel`.

**Claim**(认领)
The assignment of responsibility for a task to an owner.
认领是将一项任务的责任归于一位负责人的动作。
_Avoid_: grabbing a lock, 抢卡 as the domain name.
_Current identifiers_: `tasks.owner`; CLI `claim`.

**Start**(开工)
The beginning of work on an assigned task, with an explicit statement of the current work.
开工是已认领任务开始执行、并明确当前工作内容的时点。
_Avoid_: claim as a synonym for starting work.
_Current identifiers_: `tasks.started_at`, `tasks.now`; CLI `start`.

**Transition**(状态推进)
A permitted change from one task lifecycle state to another, with the evidence required for that change.
状态推进是满足相应证据要求后发生的合法任务状态变更。
_Avoid_: advance, 翻牌 as the canonical term.
_Current identifiers_: `tasks.status`, `tasks.waiting_on`; CLI `transition` (hidden alias `advance`).

**Reopen**(重开)
The return of a terminal task to an active lifecycle with a recorded reason.
重开是附带原因将终态任务恢复到可继续工作的生命周期。
_Avoid_: silent reset, deleting completion history.
_Current identifiers_: CLI `reopen`.

### Waiting and human asks

**Waiting on**(等)
The outstanding condition attached to a task that is ready for acceptance. Its categories are Decision, Deploy, Observation, and External.
等是待验收任务仍需满足的条件，分为等拍板、等上线、等观察和等外部。
_Avoid_: blocked as a synonym for every wait.
_Current identifiers_: `tasks.waiting_on` = `decision`, `prod`, `observe`, `external`.

**Waiting on decision**(等拍板)
A wait for a human response to an outstanding ask associated with the task.
等拍板是等待人回答与任务关联的待办请求。
_Avoid_: decision as a completed verdict when describing this wait.
_Current identifiers_: `tasks.waiting_on` = `decision`.

**Deploy**(等上线)
A waiting category for the deployment needed to complete a task's delivery.
等上线是任务交付仍需部署生效的等待类别。
_Avoid_: prod as the English display word; approved as proof of deployment.
_Current identifiers_: `tasks.waiting_on` = `prod`.

**Observation**(等观察)
A waiting category for evidence that requires an observation period.
等观察是仍需经过观察期取得证据的等待类别。
_Avoid_: observe as the English display word; elapsed time as proof of success.
_Current identifiers_: `tasks.waiting_on` = `observe`.

**External**(等外部)
A waiting category for an outstanding action or condition outside the current worker's control.
等外部是仍需当前执行者控制范围之外的动作或条件的等待类别。
_Avoid_: unexplained blocking, generic pause.
_Current identifiers_: `tasks.waiting_on` = `external`.

**Ask**(待办请求)
A request for a human action, accompanied by evidence and linked tasks. Its kinds are Decision, Approval, and Acceptance.
待办请求是附有材料并关联任务的人侧动作请求，分为拍板、放行和验收。
_Avoid_: letter, notification, generic chat message.
_Current identifiers_: `asks`; CLI `ask`.

**Decision**(拍板)
An ask for a choice among alternatives with explicit consequences.
拍板是要求在具有明确后果的选项之间作出选择的请求。
_Avoid_: decide as the English display label; approval for a choice between alternatives.
_Current identifiers_: `asks.kind` = `decide`.

**Approval**(放行)
An ask for authorization to perform a specified action with a stated impact and recovery path.
放行是请求授权执行指定动作，并说明影响范围与恢复方式。
_Avoid_: authorize, 授权 as alternative ask labels; successful execution as a synonym.
_Current identifiers_: `asks.kind` = `authorize`.

**Acceptance**(验收)
An ask for a human assessment of a delivered result against its acceptance criteria and evidence.
验收是请人依据成功判据和证据判断已交付结果的请求。
_Avoid_: accept as the English display label; CI success as human acceptance.
_Current identifiers_: `asks.kind` = `accept`; `asks.hands_on`.

**Evidence hint**(证据提示)
A non-blocking notice to the author of an Acceptance ask that its evidence may lack an observed result.
证据提示是提醒验收请求作者其证据可能缺少实际观测结果的非拦截提示。
_Avoid_: gate, rejection, Readability hint.
_Current identifiers_: stderr warning after CLI `ask` for Acceptance.

**Inbox**(收件箱)
The human-facing queue of asks awaiting a response, together with their resolved history.
收件箱是供人处理待办请求及查看已处理记录的队列。
_Avoid_: letters queue, agent notification stream.
_Current identifiers_: `asks.closed_at`; CLI `inbox`.

**Approve**(放行)
The inbox action that grants the authorization requested by an Approval ask.
放行是收件箱中同意执行放行请求所述动作的操作。
_Avoid_: mark done, deployment succeeded.
_Current identifiers_: `asks.answer`; CLI `answer`.

**Request changes**(打回)
The inbox action that rejects the submitted result and calls for rework on the affected task.
打回是拒绝当前提交结果并要求相关任务返工的收件箱操作。
_Avoid_: delete, cancel the requirement.
_Current identifiers_: CLI `answer` with `--reject`.

**Acknowledge**(收下)
The inbox action that records a positive response to a delivered result presented for Acceptance.
收下是对验收请求中的交付结果作出肯定答复的收件箱操作。
_Avoid_: merely mark a notification read, 放行 as approval for future execution.
_Current identifiers_: `asks.answer`; CLI `answer`.

**Answer**(回答)
The recorded human response that resolves an ask and supplies the resulting decision.
回答是用于解决待办请求并留下决策的人类答复记录。
_Avoid_: agent-invented human verdict, notification acknowledgment.
_Current identifiers_: `asks.answer`, `asks.closed_at`, `asks.closed_as`; CLI `answer`.

**Approval gate**(审批闸)
The boundary that requires the relevant human ask to be resolved before the guarded action or completion is permitted.
审批闸是要求相关人侧请求得到处理后，才允许受控动作或完成推进的边界。
_Avoid_: asks mechanism as the product name; blanket permission from an unrelated answer.
_Current identifiers_: `asks`, `task_decisions`.

**Fanout**(扇出)
The application of one ask's outcome to its linked tasks, with execution success distinguished from authorization.
扇出是将一个请求的结果应用于关联任务，并区分获得授权和执行成功。
_Avoid_: automatic success after approval, batch atomicity.
_Current identifiers_: CLI `fanout`.

### Scope, responsibility, and delivery

**Acceptance criteria**(成功判据)
The observable conditions that define whether a task has achieved its intended outcome.
成功判据是用于判断任务是否实现预期结果的可观察条件。
_Avoid_: success as the English field label, implementation checklist.
_Current identifiers_: `tasks.success`.

**Readability hint**(可读性提示)
A non-blocking notice to the author that a task's written text may not be understood by the non-technical reader it is meant for; the intended reader depends on the field.
可读性提示是提醒作者任务文字可能读不懂的非拦截提示，目标读者由字段决定。
_Avoid_: gate, rejection, blocking check.
_Current identifiers_: stderr warning after CLI `create`, `retitle`.

**Constraints**(约束)
The boundaries and exclusions that a task's execution must respect.
约束是任务执行必须遵守的边界与不做事项。
_Avoid_: optional preferences, acceptance evidence.
_Current identifiers_: `tasks.constraints_`.

**Context**(来由)
The background and intended work that explain why a task exists.
来由是解释任务为何存在的背景与拟完成工作。
_Avoid_: origin as the English field label, activity history.
_Current identifiers_: `tasks.context`; CLI `create --context`, `--context-file` (aliases `--origin`, `--origin-file`).

**Scope**(范围)
The declared set of paths a task is authorized to change.
范围是任务获准修改的路径集合。
_Avoid_: touches as the product label, ownership of every nearby file.
_Current identifiers_: `tasks.touches`; CLI `scope`, `release`.

**Epic**(模块)
A grouping of related tasks pursuing a shared destination, accompanied by a map of decisions and remaining work.
模块是围绕共同终点组织的任务集合，配有记录决策和剩余工作的地图。
_Avoid_: parent task as a synonym, milestone as an interchangeable grouping.
_Current identifiers_: `tasks.epic`; CLI `meta`.

**Project**(项目)
A task's project affiliation, used to filter tasks and human asks within a shared board database.
项目是任务的归属标记，用于在同一个看板数据库内筛选任务与待办请求。
_Avoid_: database selection, Epic as an interchangeable grouping.
_Current identifiers_: `tasks.project`; CLI `create --project`, `meta --set-project` (fill empty only); API `project` query parameter, `unassigned=1` for cards without a project.

**Owner**(负责人)
The accountable identity assigned to a task for its current work.
负责人是承担任务当前工作责任的身份。
_Avoid_: window title, process identifier, permanent lock holder.
_Current identifiers_: `tasks.owner`.

**Session**(窗口)
A recorded attempt by an agent to work on a task, with a beginning and an eventual outcome.
窗口是代理处理任务的一次工作履历，具有开始时间和最终结果。
_Avoid_: owner as an interchangeable identity, terminal pane as proof of task completion.
_Current identifiers_: `task_sessions`, `session_id`.

**Worktree**(工位)
The isolated working checkout assigned to a worker's task.
工位是分配给执行者处理任务的独立工作副本。
_Avoid_: shared main checkout, 工作区 when it ambiguously means the entire project.
_Current identifiers_: task scope paths in `tasks.touches`.

**Handoff**(交接)
The recorded end of a session's work, stating the delivered result, remaining work, and current next step.
交接是一次窗口工作的结束记录，说明交付结果、剩余工作和当前下一步。
_Avoid_: idle, done without delivery evidence.
_Current identifiers_: `task_sessions.outcome`, `task_sessions.summary`, `tasks.now`, `task_events`; CLI `handoff`.

**Wrapup**(收尾)
The accounting of a session's tasks whose handoff records are still incomplete.
收尾是核对本窗口尚未补齐交接记录的任务。
_Avoid_: implicit handoff, closing a window as proof of completion.
_Current identifiers_: `task_sessions`; CLI `wrapup`.

**Notifications**(信)
Task-linked messages that report progress, coordination needs, or obstacles to another participant.
信是关联任务、向协作方报告进展、协调事项或阻碍的消息。
_Avoid_: letters as the English product label; asks as a synonym.
_Current identifiers_: `letters`, `letters.read_at`; CLI `notify`, `notifications`, `notify-read` (hidden aliases `letter`, `letters`, `letter-read`).

### Relationships and evidence

**Dependencies**(依赖)
The prerequisite relationships between tasks, shown alongside task lineage for coordination.
依赖是任务之间的前置关系，并与任务家谱一起呈现以支持协作。
_Avoid_: kin as the product label; parenthood as proof of a prerequisite.
_Current identifiers_: `task_edges`, `depends_on`; CLI `deps`, `link` (hidden alias `kin`).

**Blocked by**(被挡)
The unfinished prerequisite tasks that prevent a task from proceeding.
被挡指阻止当前任务继续推进的尚未完成前置任务。
_Avoid_: waiting_on as an interchangeable cause, every upstream task regardless of completion.
_Current identifiers_: `task_edges.kind` = `depends_on`; `blocked_by`.

**Lineage**(家谱)
The recorded relationships showing which task was split from or superseded by another.
家谱是记录任务从何拆出或被何任务替代的关系。
_Avoid_: dependency as a synonym for every relationship.
_Current identifiers_: `task_edges.kind` = `split_from`, `supersedes`; CLI `link`, `deps` (hidden alias `kin`).

**Frontier**(可开工任务)
The unassigned tasks whose prerequisites are all complete.
可开工任务是所有前置任务都已完成的待认领任务集合。
_Avoid_: every open task, every independent task regardless of status.
_Current identifiers_: `tasks.status` = `open`; `task_edges.kind` = `depends_on`.

**Decision log**(决策记录)
The durable record of questions, verdicts, and rejected alternatives associated with a task.
决策记录是关联任务的问题、结论和被否选项的持久记录。
_Avoid_: chat history, mutable notes as the authoritative verdict.
_Current identifiers_: `task_decisions`; CLI `decide`.

**Reference**(引用)
A pointer from a task to an external artifact, code revision, or verification record.
引用是从任务指向外部产物、代码版本或验证记录的指针。
_Avoid_: evidence copied into every task, unverified link as proof of success.
_Current identifiers_: `task_refs`; CLI `ref`.

**Acceptance evidence**(验收证据)
An observed result and its retrievable record supporting an acceptance criterion.
验收证据是支持成功判据的实际观测结果及其可查记录。
_Avoid_: planned test, deployment intent, fabricated run.
_Current identifiers_: `task_refs.kind` = `acceptance_run`.

**Event**(事件)
A recorded occurrence in a task's history, such as a progress note, verification, handoff, or state change.
事件是任务历史中的一次记录，例如进展、验证、交接或状态变更。
_Avoid_: current state as a synonym for the history.
_Current identifiers_: `task_events`; CLI `event`.

**Activity**(活动)
The chronological view of a task's recorded events and related milestones.
活动是任务事件及相关里程碑按时间组织的视图。
_Avoid_: separate activity store, agent liveness as the same concept.
_Current identifiers_: `task_events`, `tasks.started_at`, `tasks.completed_at`.

**Board**(看板)
The shared view of tasks grouped by lifecycle state.
看板是按生命周期状态组织任务的共享视图。
_Avoid_: writable status change merely from a preview drag.
_Current identifiers_: `tasks.status`.

**Board initialization**(建库)
The explicit creation of a new task board's persistent store.
建库是显式创建一个新任务看板的持久存储。
_Avoid_: silently replacing a missing existing board; `workos` is the historical runtime name.
_Current identifiers_: CLI `init`; `.nawaban/nawaban.db`, `NAWABAN_DB`.

**Board backup**(全量备份)
A recoverable copy of a board's persistent records.
全量备份是可供恢复的看板持久记录副本。
_Avoid_: source checkout as a backup of live task data.
_Current identifiers_: CLI `backup`.

### Captured ideas

**Capture**(捕捉)
An unstructured idea kept outside the task board until an agent links it to a formal task or discards it with a reason.
捕捉是独立于任务看板的一条想法，由 Agent 转成正式任务并保留来源，或写明原因作废。
_Avoid_: quick task, backlog column, task count, 快速建卡, 看板列.
_Current identifiers_: `captures`; CLI `capture`, `add`, `list`, `convert`, `discard`.

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
| Capture | 捕捉 | Capture queue only; not task lifecycle |
| Search ideas, capture IDs or linked tasks | 搜索想法、捕捉编号或关联卡 | Capture queue only; not task lifecycle |
| Jot down an idea. An agent will turn it into a formal task or record why it was discarded. | 先记下一句想法。Agent 整理后会转成正式卡片，或说明作废原因。 | Capture queue only; not task lifecycle |
| Idea | 想法 | Capture queue only; not task lifecycle |
| Save idea | 记下想法 | Capture queue only; not task lifecycle |
| Saving… | 正在保存… | Capture queue only; not task lifecycle |
| Retry save | 重试保存 | Capture queue only; not task lifecycle |
| Save to: {project} | 记录到：{project} | Capture queue only; not task lifecycle |
| The save result is unknown. Retrying checks the same idea and will not save a duplicate. | 保存结果未知。重试会核对同一条想法，不会重复保存。 | Capture queue only; not task lifecycle |
| All captures | 全部捕捉 | Capture queue only; not task lifecycle |
| Pending | 待处理 | Capture queue only; not task lifecycle |
| Show pending only | 只看待处理 | Capture queue only; not task lifecycle |
| Show history | 查看处理记录 | Capture queue only; not task lifecycle |
| Loading captures… | 正在读取捕捉… | Capture queue only; not task lifecycle |
| No matching captures | 没有匹配的捕捉 | Capture queue only; not task lifecycle |
| Converted | 已转卡 | Capture queue only; not task lifecycle |
| Discarded | 已作废 | Capture queue only; not task lifecycle |
| Discard reason: {reason} | 作废原因：{reason} | Capture queue only; not task lifecycle |
| Captured idea | 来自捕捉 | Capture queue only; not task lifecycle |
| Refresh tasks | 刷新真实数据 | Board toolbar and synchronization status |
| Filter waiting items | 筛选等待事项 | Board toolbar and synchronization status |
| All waiting items | 全部等待事项 | Board toolbar and synchronization status |
| Syncing… | 同步中… | Board toolbar and synchronization status |
| Synced at {time} | 同步于 {time} | Board toolbar and synchronization status |
| Refresh every {seconds} seconds | 每 {seconds} 秒刷新 | Board toolbar and synchronization status |
| Sync failed | 同步失败 | Board toolbar and synchronization status |
| Collapse sidebar ([) | 收起侧栏([) | A control label that describes an action different from what the control performs. |
| Collapse sidebar  [ | 收起侧栏  [ | A control label that describes an action different from what the control performs. |
| Expand sidebar ([) | 展开侧栏([) | A control label that describes an action different from what the control performs. |
| Expand sidebar  [ | 展开侧栏  [ | A control label that describes an action different from what the control performs. |
| Search ID / title / owner / epic (/ to focus · Esc to clear) | 搜索 id / 标题 / owner / epic(/ 聚焦 · Esc 清空) | A control label that describes an action different from what the control performs. |
| Workspace | 工作区 | Runtime enum values as display labels or a different action sharing this label. |
| Filter | 筛选 | Narrows the task collection by module, waiting reason, or updated date. |
| Language | 语言 | Runtime enum values as display labels or a different action sharing this label. |
| Switch to Chinese | 切换到英文 | Runtime enum values as display labels or a different action sharing this label. |
| Waiting on observation | 等观察 | Runtime enum values as display labels or a different action sharing this label. |
| Waiting on external | 等外部 | Runtime enum values as display labels or a different action sharing this label. |
| Waiting on deploy | 等上线 | Runtime enum values as display labels or a different action sharing this label. |
| Running | 在跑 | Task completion or ownership as a synonym for session activity. |
| Session idle | 窗口闲着 | Task completion or ownership as a synonym for session activity. |
| Session inactive | 窗口早没动静 | Task completion or ownership as a synonym for session activity. |
| Session not found | 找不到窗口 | Task completion or ownership as a synonym for session activity. |
| Loading… | 加载中… | Runtime enum values as display labels or a different action sharing this label. |
| Change status through the CLI | 状态变更走 CLI | Runtime enum values as display labels or a different action sharing this label. |
| Dragging previews the board; it does not change task status | 看板拖拽仅供预览,不会改变任务状态 | Runtime enum values as display labels or a different action sharing this label. |
| No sessions running | 无窗口在动 | Success or populated-state wording when data or an operation is unavailable. |
| Board failed to load: | 看板加载失败: | Success or populated-state wording when data or an operation is unavailable. |
| ● {count} running | ● {count} 在动 | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} idle | {count} 闲着 | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} sessions gone | {count} 窗口已不在 | Dropped interpolation values or raw template placeholders in rendered text. |
| Inactive for {time} | {time} 没动 | Dropped interpolation values or raw template placeholders in rendered text. |
| Existing PR {refs} · awaiting a status decision | 已有 PR {refs} · 状态待人裁定 | Dropped interpolation values or raw template placeholders in rendered text. |
| Blocked by {tasks} | 被 {tasks} 挡 | Dropped interpolation values or raw template placeholders in rendered text. |
| Today | 今天 | Runtime enum values as display labels or a different action sharing this label. |
| Yesterday | 昨天 | Runtime enum values as display labels or a different action sharing this label. |
| This week | 本周 | Runtime enum values as display labels or a different action sharing this label. |
| Last week | 上周 | Runtime enum values as display labels or a different action sharing this label. |
| Last 7 days | 最近 7 天 | Runtime enum values as display labels or a different action sharing this label. |
| Start date | 起始日期 | A control label that describes an action different from what the control performs. |
| End date | 结束日期 | A control label that describes an action different from what the control performs. |
| Updated | 更新时间 | A control label that describes an action different from what the control performs. |
| Acceptance confirmed (one-click inbox) | 验收通过(收件箱一键) | Runtime enum values as display labels or a different action sharing this label. |
|  · Supplement: |  · 补充: | Runtime enum values as display labels or a different action sharing this label. |
| Confirm decision | 就这么定 | Authorization or a recorded answer as proof that the action executed successfully. |
| Other… | 其他… | Runtime enum values as display labels or a different action sharing this label. |
| Answer (recorded verbatim in the decision log) | 回答(会原样进决策记录) | Authorization or a recorded answer as proof that the action executed successfully. |
| Additional details (optional) | 补充说明(非必填) | Runtime enum values as display labels or a different action sharing this label. |
| Select an option first | 先选一个选项 | A control label that describes an action different from what the control performs. |
| Reason for requesting changes | 打回理由 | Runtime enum values as display labels or a different action sharing this label. |
|  (recorded verbatim in the decision log) | (会原样进决策记录) | Authorization or a recorded answer as proof that the action executed successfully. |
| Copied | 已复制 | Runtime enum values as display labels or a different action sharing this label. |
| Copy failed; select the text manually | 复制失败,手动选中吧 | A control label that describes an action different from what the control performs. |
| No decisions waiting | 没有需要你决定的事 | Success or populated-state wording when data or an operation is unavailable. |
| Select an item for details | 选一条看详情 | A control label that describes an action different from what the control performs. |
| The inbox is empty | 收件箱是空的 | Success or populated-state wording when data or an operation is unavailable. |
| Try it yourself | 要你亲自点 | Runtime enum values as display labels or a different action sharing this label. |
| Approval only records your decision —  | 授权只记录你的决定 ——  | Authorization or a recorded answer as proof that the action executed successfully. |
| it does not execute automatically | 不会自动执行 | Authorization or a recorded answer as proof that the action executed successfully. |
| . Once the action has actually run, report its result: | 。动作真跑完之后再收口: | Runtime enum values as display labels or a different action sharing this label. |
|  (use --failed for failure) | (失败用 --failed) | Success or populated-state wording when data or an operation is unavailable. |
| Cancel | 取消 | Runtime enum values as display labels or a different action sharing this label. |
| Submit | 提交 | Runtime enum values as display labels or a different action sharing this label. |
| Copy | 复制 | Runtime enum values as display labels or a different action sharing this label. |
| Inbox failed to load: | 收件箱加载失败: | Success or populated-state wording when data or an operation is unavailable. |
| #{id} resolved | #{id} 已处理 | Dropped interpolation values or raw template placeholders in rendered text. |
| {percent}% confidence | {percent}% 把握 | Dropped interpolation values or raw template placeholders in rendered text. |
| 🤖 Self-approved tasks · {count} in the last 7 days ({lane} with evidence{silent} · request changes if needed) | 🤖 自批归档 digest · 近 7 天 {count} 张(自证 lane {lane} 条逐列{silent} · 看着不对就打回) | Dropped interpolation values or raw template placeholders in rendered text. |
|  · {count} summarized from the legacy path |  · 旧静默路 {count} 张计数压行 | Dropped interpolation values or raw template placeholders in rendered text. |
| The other {count} tasks were closed through deploy/observation/external paths without human participation (existing behavior). | 其余 {count} 张经 prod/observe/external 路无人参与归档(历来如此)。 | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} asks waiting · oldest {days} days | {count} 件事等你 · 最久停了 {days} 天 | Dropped interpolation values or raw template placeholders in rendered text. |
|  · This week: {raised} received · {closed} resolved |  · 本周进 {raised} · 已清 {closed} | Dropped interpolation values or raw template placeholders in rendered text. |
| Ungrouped | 未分组 | Runtime enum values as display labels or a different action sharing this label. |
| Working now: | 现在动着的: | Runtime enum values as display labels or a different action sharing this label. |
|  (independent task) | (独立卡) | Runtime enum values as display labels or a different action sharing this label. |
| No tasks in progress | 没有进行中的卡 | Success or populated-state wording when data or an operation is unavailable. |
|  · Upstream |  · 上游 | Runtime enum values as display labels or a different action sharing this label. |
|  · Downstream |  · 下游 | Runtime enum values as display labels or a different action sharing this label. |
| ▸ Blocked by = unfinished prerequisite | ▸ 被挡 = 上游未 done | Runtime enum values as display labels or a different action sharing this label. |
| ▸ Blocked by | ▸ 被挡 | Runtime enum values as display labels or a different action sharing this label. |
| ← Depends on  | ← 依赖  | Runtime enum values as display labels or a different action sharing this label. |
| Epics failed to load: | 模块加载失败: | Success or populated-state wording when data or an operation is unavailable. |
| Epic data is currently unavailable | 模块数据当前不可用 | Success or populated-state wording when data or an operation is unavailable. |
| Epics · sorted by unfinished tasks | 模块 · 按未完成量排序 | Runtime enum values as display labels or a different action sharing this label. |
| Focus mode · select a task to see its dependencies | 专注模式 · 点卡看它的链 | A control label that describes an action different from what the control performs. |
| This epic has no internal dependency chain; all tasks are independent. | 这个模块内部没有依赖链——所有卡都是独立卡。 | Success or populated-state wording when data or an operation is unavailable. |
| Independent tasks (outside the chain) ·  | 独立卡(不在链上)·  | Runtime enum values as display labels or a different action sharing this label. |
| No epic data | 没有模块数据 | Success or populated-state wording when data or an operation is unavailable. |
|  (stage {stage}/{total}) | (第 {stage}/{total} 级) | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} tasks · {percent}% done · Done {done} / Ready for acceptance {ready} / Assigned + In progress {active} / Unassigned {open} · {now} | {count} 卡 · 完成 {percent}% · done {done} / 待验收 {ready} / 进行中 {active} / open {open} · {now} | Dropped interpolation values or raw template placeholders in rendered text. |
| Stage {stage} | 第 {stage} 级 | Dropped interpolation values or raw template placeholders in rendered text. |
| Just now | 刚刚 | Runtime enum values as display labels or a different action sharing this label. |
| Collapse | 收起 | Runtime enum values as display labels or a different action sharing this label. |
| Expand | 展开 | Runtime enum values as display labels or a different action sharing this label. |
| No epic | 无 epic | Success or populated-state wording when data or an operation is unavailable. |
| Status | 状态 | Runtime enum values as display labels or a different action sharing this label. |
| Not waiting | 不等谁 | Runtime enum values as display labels or a different action sharing this label. |
| Time | 时间 | Runtime enum values as display labels or a different action sharing this label. |
| Split from | 拆自 | Runtime enum values as display labels or a different action sharing this label. |
| Split out | 拆出 | Runtime enum values as display labels or a different action sharing this label. |
| Supersedes | 替代了 | Runtime enum values as display labels or a different action sharing this label. |
| Superseded by | 被替代 | Runtime enum values as display labels or a different action sharing this label. |
| Unread | 未读 | Runtime enum values as display labels or a different action sharing this label. |
| Failed to load: | 加载失败: | Success or populated-state wording when data or an operation is unavailable. |
| Blocked at  | 真正卡在  | Runtime enum values as display labels or a different action sharing this label. |
| Unblocks | 放开 | Runtime enum values as display labels or a different action sharing this label. |
| Rejected: | 否: | Runtime enum values as display labels or a different action sharing this label. |
| Properties | 属性 | Runtime enum values as display labels or a different action sharing this label. |
| Relationships | 关系 | Runtime enum values as display labels or a different action sharing this label. |
| {count} minutes ago | {count} 分钟前 | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} hours ago | {count} 小时前 | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} days ago | {count} 天前 | Dropped interpolation values or raw template placeholders in rendered text. |
| Copy {text} | 复制 {text} | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} more | 还有 {count} 条 | Dropped interpolation values or raw template placeholders in rendered text. |
| Wrapup · {outcome} | 收尾 · {outcome} | Dropped interpolation values or raw template placeholders in rendered text. |
| No {label} | 无 {label} | Dropped interpolation values or raw template placeholders in rendered text. |
| Created {time} | 创建 {time} | Dropped interpolation values or raw template placeholders in rendered text. |
| Started {time} | 开工 {time} | Dropped interpolation values or raw template placeholders in rendered text. |
| Done {time} | 完成 {time} | Dropped interpolation values or raw template placeholders in rendered text. |
| {count} others still waiting on prerequisites | 另有 {count} 张还在等别人 | Dropped interpolation values or raw template placeholders in rendered text. |
| Close | 关闭 | Runtime enum values as display labels or a different action sharing this label. |
| No owner | 未认领 | Unassigned as the owner field label; this is not a lifecycle state. |
| EN | 中文 | Display text only; preserve stored values and user-authored content. |
| Main navigation | 主导航 | Display text only; preserve stored values and user-authored content. |
| Agent workspace | Agent 工作空间 | Display text only; preserve stored values and user-authored content. |
| Toggle sidebar | 切换侧栏 | Display text only; preserve stored values and user-authored content. |
| All projects | 全部项目 | Display text only; preserve stored values and user-authored content. |
| No project | 无项目 | Cards with a null or empty project; distinct from all projects. |
| Switch project | 切换项目 | Display text only; preserve stored values and user-authored content. |
| Agents advance tasks | 任务由 Agent 推进 | Display text only; preserve stored values and user-authored content. |
| Your decisions are collected in the inbox | 需要你的决定，集中在收件箱 | Display text only; preserve stored values and user-authored content. |
| Needs my attention | 待我处理 | Display text only; preserve stored values and user-authored content. |
| Search tasks | 搜索任务 | Display text only; preserve stored values and user-authored content. |
| Search ID, title, epic… | 搜索编号、标题、模块… | Display text only; preserve stored values and user-authored content. |
| Search questions, related tasks… | 搜索问题、关联任务… | Display text only; preserve stored values and user-authored content. |
| Search ID, title, owner… | 搜索编号、标题、负责人… | Display text only; preserve stored values and user-authored content. |
| List | 列表 | Display text only; preserve stored values and user-authored content. |
| {count} tasks | {count} 张任务 | Display text only; preserve stored values and user-authored content. |
| Task list | 任务列表 | Display text only; preserve stored values and user-authored content. |
| ID | 编号 | Display text only; preserve stored values and user-authored content. |
| Title | 标题 | Display text only; preserve stored values and user-authored content. |
| Epic name | 模块名 | Display text only; preserve stored values and user-authored content. |
| No matching tasks | 没有匹配的任务 | Display text only; preserve stored values and user-authored content. |
| All epics | 全部模块 | Display text only; preserve stored values and user-authored content. |
| Filter epics | 筛选工作模块 | Display text only; preserve stored values and user-authored content. |
| Loading tasks… | 正在读取任务… | Display text only; preserve stored values and user-authored content. |
| Custom updated date range | 自定义更新时间范围 | Display text only; preserve stored values and user-authored content. |
| Custom dates | 自定义日期 | Display text only; preserve stored values and user-authored content. |
| Clear filters | 清除筛选 | Display text only; preserve stored values and user-authored content. |
| Collapse original | 收起原文 | Display text only; preserve stored values and user-authored content. |
| View original | 查看原文 | Display text only; preserve stored values and user-authored content. |
| Decision needed; open inbox | 需要决策，前往收件箱 | Display text only; preserve stored values and user-authored content. |
| Session is working | 窗口正在工作 | Display text only; preserve stored values and user-authored content. |
| Session is idle | 窗口空闲，暂未工作 | Display text only; preserve stored values and user-authored content. |
| Session has been inactive | 窗口长时间无活动 | Display text only; preserve stored values and user-authored content. |
| Status unknown; no session signal | 状态未知，暂无窗口信号 | Display text only; preserve stored values and user-authored content. |
| Active just now | 刚刚有活动 | Display text only; preserve stored values and user-authored content. |
| Last active {count} minutes ago | 最后活动 {count} 分钟前 | Display text only; preserve stored values and user-authored content. |
| Last active {count} hours ago | 最后活动 {count} 小时前 | Display text only; preserve stored values and user-authored content. |
| Last active {count} days ago | 最后活动 {count} 天前 | Display text only; preserve stored values and user-authored content. |
| View {id} {title} | 查看 {id} {title} | Display text only; preserve stored values and user-authored content. |
| Status legend | 状态图例 | Display text only; preserve stored values and user-authored content. |
| Task corner signals: | 卡片右上角的灯： | Display text only; preserve stored values and user-authored content. |
| Working | 正在工作 | Display text only; preserve stored values and user-authored content. |
| Session unresponsive | 窗口无响应 | Display text only; preserve stored values and user-authored content. |
| Status unknown | 状态未知 | Display text only; preserve stored values and user-authored content. |
| Session signals are currently unavailable | 窗口信号当前不可用 | Display text only; preserve stored values and user-authored content. |
| Expand full text | 展开全文 | Display text only; preserve stored values and user-authored content. |
| Task details {id} | 任务详情 {id} | Display text only; preserve stored values and user-authored content. |
| Back | 返回 | Display text only; preserve stored values and user-authored content. |
| Current progress | 当前进展 | Display text only; preserve stored values and user-authored content. |
| Stage | 阶段 | Display text only; preserve stored values and user-authored content. |
| Decision document | 决策文档 | Display text only; preserve stored values and user-authored content. |
| Dismiss notification | 关闭通知 | Display text only; preserve stored values and user-authored content. |
| Failed to load | 加载失败 | Display text only; preserve stored values and user-authored content. |
| Switch to light mode | 切换浅色模式 | Display text only; preserve stored values and user-authored content. |
| Switch to dark mode | 切换深色模式 | Display text only; preserve stored values and user-authored content. |
| Theme | 主题 | Display text only; preserve stored values and user-authored content. |
| Light mode | 浅色模式 | Display text only; preserve stored values and user-authored content. |
| Dark mode | 深色模式 | Display text only; preserve stored values and user-authored content. |
| Outcome unknown. Refresh to verify before submitting again. | 处理结果未知，请先刷新核对，不要重复提交。 | Display text only; preserve stored values and user-authored content. |
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
| Loading dependencies… | 正在读取依赖关系… | Display text only; preserve stored values and user-authored content. |
| Epics · unfinished / total | 模块 · 未完成 / 总数 | Display text only; preserve stored values and user-authored content. |
| {count} tasks · {percent}% done · Done {done} / Ready for acceptance {ready} / Assigned {assigned} / In progress {active} / Unassigned {open} | {count} 卡 · 完成 {percent}% · 完成 {done} / 待验收 {ready} / 已认领 {assigned} / 进行中 {active} / 待认领 {open} | Display text only; preserve stored values and user-authored content. |
| Focus mode | 专注模式 | Display text only; preserve stored values and user-authored content. |
| Decision options | 决策选项 | Display text only; preserve stored values and user-authored content. |
| Other decision | 其他决策 | Display text only; preserve stored values and user-authored content. |
| Additional details | 补充说明 | Display text only; preserve stored values and user-authored content. |
| Waiting {days} days | 等待 {days} 天 | Display text only; preserve stored values and user-authored content. |
| {days} days | {days} 天 | Display text only; preserve stored values and user-authored content. |
| Approval records your decision. An agent still needs to execute the action and report the result. | 授权只记录你的决定，操作仍需由 Agent 执行并回报结果。 | Display text only; preserve stored values and user-authored content. |
| Refresh inbox to verify the result | 刷新收件箱，核对处理结果 | Display text only; preserve stored values and user-authored content. |
| Copy command | 复制命令 | Display text only; preserve stored values and user-authored content. |
| Automatically archived · {count} in the last 7 days | 自动归档 · 近 7 天 {count} 张 | Display text only; preserve stored values and user-authored content. |
| {count} with evidence{other} | 可核对 {count} 张{other} | Display text only; preserve stored values and user-authored content. |
|  · {count} others |  · 其他 {count} 张 | Display text only; preserve stored values and user-authored content. |
| The remaining {count} tasks were archived by other automated workflows. | 其余 {count} 张由其他自动流程归档。 | Display text only; preserve stored values and user-authored content. |
| Inbox data is currently unavailable | 收件箱数据当前不可用 | Display text only; preserve stored values and user-authored content. |
| Loading inbox… | 正在读取收件箱… | Display text only; preserve stored values and user-authored content. |
| Refresh failed; current drafts are preserved: {error} | 刷新失败，保留当前草稿：{error} | Display text only; preserve stored values and user-authored content. |
| No matching pending items | 没有匹配的待处理事项 | Display text only; preserve stored values and user-authored content. |
| {time} ago | {time}前 | Display text only; preserve stored values and user-authored content. |
| Select an item | 选择一项 | Display text only; preserve stored values and user-authored content. |
| Pagination | 分页 | Display text only; preserve stored values and user-authored content. |
| Previous page | 上一页 | Display text only; preserve stored values and user-authored content. |
| Next page | 下一页 | Display text only; preserve stored values and user-authored content. |
| Previous | 上一页 | Display text only; preserve stored values and user-authored content. |
| Next | 下一页 | Display text only; preserve stored values and user-authored content. |
| Go to page {page} | 前往第 {page} 页 | Display text only; preserve stored values and user-authored content. |
| Upload a file | 上传文件 | Display text only; preserve stored values and user-authored content. |
| Drag and drop to upload or | 拖放以上传，或 | Display text only; preserve stored values and user-authored content. |
| select | 选择文件 | Display text only; preserve stored values and user-authored content. |
| Only {types} files are supported | 仅支持 {types} 文件 | Display text only; preserve stored values and user-authored content. |
| That file is larger than {size} | 文件大小超过 {size} | Display text only; preserve stored values and user-authored content. |
| {types} (max {size}) | {types}（最大 {size}） | Display text only; preserve stored values and user-authored content. |
| Uploading {size}… | 正在上传 {size}… | Display text only; preserve stored values and user-authored content. |
| Uploaded successfully! | 上传成功！ | Display text only; preserve stored values and user-authored content. |
