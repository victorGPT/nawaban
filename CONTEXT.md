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

### Interface messages

Exact display templates below are part of the English vocabulary. Braced names are interpolation slots; Chinese text preserves the existing interface. These entries govern display only, not stored enum values or user-authored task content.

| English | 中文 | _Avoid_ |
|---|---|---|
| Collapse sidebar ([) | 收起侧栏([) | Alternative wording for this interface message. |
| Collapse sidebar  [ | 收起侧栏  [ | Alternative wording for this interface message. |
| Expand sidebar ([) | 展开侧栏([) | Alternative wording for this interface message. |
| Expand sidebar  [ | 展开侧栏  [ | Alternative wording for this interface message. |
| Search ID / title / owner / epic (/ to focus · Esc to clear) | 搜索 id / 标题 / owner / epic(/ 聚焦 · Esc 清空) | Alternative wording for this interface message. |
| Workspace | 工作区 | Alternative wording for this interface message. |
| Filter | 筛选 | Alternative wording for this interface message. |
| Language | 语言 | Alternative wording for this interface message. |
| Switch to Chinese | 切换到英文 | Alternative wording for this interface message. |
| Waiting on observation | 等观察 | Alternative wording for this interface message. |
| Waiting on external | 等外部 | Alternative wording for this interface message. |
| Waiting on deploy | 等上线 | Alternative wording for this interface message. |
| Running | 在跑 | Alternative wording for this interface message. |
| Session idle | 窗口闲着 | Alternative wording for this interface message. |
| Session inactive | 窗口早没动静 | Alternative wording for this interface message. |
| Session not found | 找不到窗口 | Alternative wording for this interface message. |
| Loading… | 加载中… | Alternative wording for this interface message. |
| Change status through the CLI | 状态变更走 CLI | Alternative wording for this interface message. |
| Dragging previews the board; it does not change task status | 看板拖拽仅供预览,不会改变任务状态 | Alternative wording for this interface message. |
| No sessions running | 无窗口在动 | Alternative wording for this interface message. |
| Board failed to load: | 看板加载失败: | Alternative wording for this interface message. |
| ● {count} running | ● {count} 在动 | Alternative wording for this interface message. |
| {count} idle | {count} 闲着 | Alternative wording for this interface message. |
| {count} sessions gone | {count} 窗口已不在 | Alternative wording for this interface message. |
| Inactive for {time} | {time} 没动 | Alternative wording for this interface message. |
| Existing PR {refs} · awaiting a status decision | 已有 PR {refs} · 状态待人裁定 | Alternative wording for this interface message. |
| Blocked by {tasks} | 被 {tasks} 挡 | Alternative wording for this interface message. |
| Today | 今天 | Alternative wording for this interface message. |
| Yesterday | 昨天 | Alternative wording for this interface message. |
| This week | 本周 | Alternative wording for this interface message. |
| Last week | 上周 | Alternative wording for this interface message. |
| Last 7 days | 最近 7 天 | Alternative wording for this interface message. |
| Start date | 起始日期 | Alternative wording for this interface message. |
| End date | 结束日期 | Alternative wording for this interface message. |
| Updated | 更新时间 | Alternative wording for this interface message. |
| Acceptance confirmed (one-click inbox) | 验收通过(收件箱一键) | Alternative wording for this interface message. |
|  · Supplement: |  · 补充: | Alternative wording for this interface message. |
| Confirm decision | 就这么定 | Alternative wording for this interface message. |
| Other… | 其他… | Alternative wording for this interface message. |
| Answer (recorded verbatim in the decision log) | 回答(会原样进决策记录) | Alternative wording for this interface message. |
| Additional details (optional) | 补充说明(非必填) | Alternative wording for this interface message. |
| Select an option first | 先选一个选项 | Alternative wording for this interface message. |
| Reason for requesting changes | 打回理由 | Alternative wording for this interface message. |
|  (recorded verbatim in the decision log) | (会原样进决策记录) | Alternative wording for this interface message. |
| Copied | 已复制 | Alternative wording for this interface message. |
| Copy failed; select the text manually | 复制失败,手动选中吧 | Alternative wording for this interface message. |
| No decisions waiting | 没有需要你决定的事 | Alternative wording for this interface message. |
| Select an item for details | 选一条看详情 | Alternative wording for this interface message. |
| The inbox is empty | 收件箱是空的 | Alternative wording for this interface message. |
| Try it yourself | 要你亲自点 | Alternative wording for this interface message. |
| Approval only records your decision —  | 授权只记录你的决定 ——  | Alternative wording for this interface message. |
| it does not execute automatically | 不会自动执行 | Alternative wording for this interface message. |
| . Once the action has actually run, report its result: | 。动作真跑完之后再收口: | Alternative wording for this interface message. |
|  (use --failed for failure) | (失败用 --failed) | Alternative wording for this interface message. |
| Cancel | 取消 | Alternative wording for this interface message. |
| Submit | 提交 | Alternative wording for this interface message. |
| Copy | 复制 | Alternative wording for this interface message. |
| Inbox failed to load: | 收件箱加载失败: | Alternative wording for this interface message. |
| #{id} resolved | #{id} 已处理 | Alternative wording for this interface message. |
| {percent}% confidence | {percent}% 把握 | Alternative wording for this interface message. |
| 🤖 Self-approved tasks · {count} in the last 7 days ({lane} with evidence{silent} · request changes if needed) | 🤖 自批归档 digest · 近 7 天 {count} 张(自证 lane {lane} 条逐列{silent} · 看着不对就打回) | Alternative wording for this interface message. |
|  · {count} summarized from the legacy path |  · 旧静默路 {count} 张计数压行 | Alternative wording for this interface message. |
| The other {count} tasks were closed through deploy/observation/external paths without human participation (existing behavior). | 其余 {count} 张经 prod/observe/external 路无人参与归档(历来如此)。 | Alternative wording for this interface message. |
| {count} asks waiting · oldest {days} days | {count} 件事等你 · 最久停了 {days} 天 | Alternative wording for this interface message. |
|  · This week: {raised} received · {closed} resolved |  · 本周进 {raised} · 已清 {closed} | Alternative wording for this interface message. |
| Ungrouped | 未分组 | Alternative wording for this interface message. |
| Working now: | 现在动着的: | Alternative wording for this interface message. |
|  (independent task) | (独立卡) | Alternative wording for this interface message. |
| No tasks in progress | 没有进行中的卡 | Alternative wording for this interface message. |
|  · Upstream |  · 上游 | Alternative wording for this interface message. |
|  · Downstream |  · 下游 | Alternative wording for this interface message. |
| ▸ Blocked by = unfinished prerequisite | ▸ 被挡 = 上游未 done | Alternative wording for this interface message. |
| ▸ Blocked by | ▸ 被挡 | Alternative wording for this interface message. |
| ← Depends on  | ← 依赖  | Alternative wording for this interface message. |
| Epics failed to load: | 模块加载失败: | Alternative wording for this interface message. |
| Epic data is currently unavailable | 模块数据当前不可用 | Alternative wording for this interface message. |
| Epics · sorted by unfinished tasks | 模块 · 按未完成量排序 | Alternative wording for this interface message. |
| Focus mode · select a task to see its dependencies | 专注模式 · 点卡看它的链 | Alternative wording for this interface message. |
| This epic has no internal dependency chain; all tasks are independent. | 这个模块内部没有依赖链——所有卡都是独立卡。 | Alternative wording for this interface message. |
| Independent tasks (outside the chain) ·  | 独立卡(不在链上)·  | Alternative wording for this interface message. |
| No epic data | 没有模块数据 | Alternative wording for this interface message. |
|  (stage {stage}/{total}) | (第 {stage}/{total} 级) | Alternative wording for this interface message. |
| {count} tasks · {percent}% done · Done {done} / Ready for acceptance {ready} / Active {active} / Unassigned {open} · {now} | {count} 卡 · 完成 {percent}% · done {done} / 待验收 {ready} / 进行中 {active} / open {open} · {now} | Alternative wording for this interface message. |
| Stage {stage} | 第 {stage} 级 | Alternative wording for this interface message. |
| Just now | 刚刚 | Alternative wording for this interface message. |
| Collapse | 收起 | Alternative wording for this interface message. |
| Expand | 展开 | Alternative wording for this interface message. |
| No epic | 无 epic | Alternative wording for this interface message. |
| Status | 状态 | Alternative wording for this interface message. |
| Not waiting | 不等谁 | Alternative wording for this interface message. |
| Time | 时间 | Alternative wording for this interface message. |
| Split from | 拆自 | Alternative wording for this interface message. |
| Split out | 拆出 | Alternative wording for this interface message. |
| Supersedes | 替代了 | Alternative wording for this interface message. |
| Superseded by | 被替代 | Alternative wording for this interface message. |
| Unread | 未读 | Alternative wording for this interface message. |
| Failed to load: | 加载失败: | Alternative wording for this interface message. |
| Blocked at  | 真正卡在  | Alternative wording for this interface message. |
| Unblocks | 放开 | Alternative wording for this interface message. |
| Rejected: | 否: | Alternative wording for this interface message. |
| Properties | 属性 | Alternative wording for this interface message. |
| Relationships | 关系 | Alternative wording for this interface message. |
| {count} minutes ago | {count} 分钟前 | Alternative wording for this interface message. |
| {count} hours ago | {count} 小时前 | Alternative wording for this interface message. |
| {count} days ago | {count} 天前 | Alternative wording for this interface message. |
| Copy {text} | 复制 {text} | Alternative wording for this interface message. |
| {count} more | 还有 {count} 条 | Alternative wording for this interface message. |
| Wrapup · {outcome} | 收尾 · {outcome} | Alternative wording for this interface message. |
| No {label} | 无 {label} | Alternative wording for this interface message. |
| Created {time} | 创建 {time} | Alternative wording for this interface message. |
| Started {time} | 开工 {time} | Alternative wording for this interface message. |
| Done {time} | 完成 {time} | Alternative wording for this interface message. |
| {count} others still waiting on prerequisites | 另有 {count} 张还在等别人 | Alternative wording for this interface message. |
| Close | 关闭 | Alternative wording for this interface message. |
