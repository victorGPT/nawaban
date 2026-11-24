# nawaban

The shared language for tasks recorded by agents and read by people. English terms are authoritative; each Chinese line expresses the same concept, while current identifiers register the runtime vocabulary.

## 管理用语

人和 agent 读到的名词用中文领域约定俗成的说法，英文原名只作出处。一行一条：词 — 在 nawaban 里的确切含义 — 出处。

- **例外管理** — 决策者只看偏离计划的：待决、红灯或黄灯的 KR、停滞的任务 — 出处：Management by Exception（Taylor；ITIL）。
- **渐进披露** — 面板和索引先给一行，细节按需展开 — 出处：Progressive Disclosure（Nielsen）。
- **任务式指挥** — 决策者定 O、点头 KR；KR 以下 agent 自己定，记成决策记录 — 出处：Mission Command（Auftragstaktik）。
- **待决策项（待决）** — 交给决策者拍板的一件事：「决策事项：」「关联 KR：」「背景：」「备选方案：」（每条「- 方案 ｜ 代价 ｜ 单向门/双向门」，至少两条）「建议：」；英文 BLUF / KR / Context / Options / Recommendation 和旧【Decision】…【Recommendation】照样读 — 出处：Decision Request；BLUF、COA（参谋作业）。
- **决策者** — 待决的拍板人 — 出处：RAPID 的 Decide（Bain）。
- **上升** — 把一件事记成待决交给决策者 — 出处：Escalate。
- **就绪标准** — 待决每项都写了且不是占位（无 / none / -），每条方案有代价；不满足即「未就绪」，写入时被拒，读出来的不进面板、退回编排者重写 — 出处：Definition of Ready（Scrum）。
- **决策记录** — 一次选择：「决定：」「背景：」「否决方案：<方案> — <原因>」，可选「影响：」；英文 Decision / Context / Rejected / Consequences 和旧 Question / Verdict 照样读 — 出处：Decision Record（ADR，Nygard）。
- **完成标准** — 任务记了已合并的 `pr:` 或 `commit:` 链接才能关成完成 — 出处：Definition of Done（Scrum）。
- **进展同步** — 一条备注「已完成：… / 下一步：… / 卡点：…」，交还任务时同样格式；英文 Done / Next / Blockers 照样读 — 出处：Status update（站会三问）。
- **停滞** — 开着、开工过、24 小时没动静 — 出处：Stale（Kanban）。
- **进行中** — 开着、开工过、24 小时内有动静 — 出处：WIP（Kanban）。
- **待办** — 开着、从没认领也没写进展 — 出处：Backlog（Scrum / Kanban）。
- **已完成** — 关成完成 — 出处：Done。
- **泳道** — 开工前要装进脑子的东西（要读的 ADR 和文档、要改的目录、要用的工具或环境）基本相同的一组任务，记成任务上的 note「lane: <名>」；`dispatch` 把同泳道的下一张交给该泳道在跑的 worker，按依赖顺序串行 — 出处：Swimlane（Kanban）。
- **负责人** — 持有一张票的那一个会话或终端 — 出处：DRI（Apple）。
- **红黄绿灯** — KR 状态：红＝未达标，黄＝过期或有风险，绿＝达标；没有读数的写「未测」 — 出处：RAG status（PRINCE2）。
- **偏差** — 实际减目标，按目标方向算：+ 领先，- 落后；百分比按「点」计 — 出处：Variance。
- **OKR 行** — 「<KR>  <实际> / 目标 <op 目标> · 偏差 <±n 单位> · <红|黄|绿> · 截至 <MM-DD>」，`okr` 输出和面板都用；面板上偏差和灯另用颜色 — 出处：OKR（Grove，Doerr）。
- **面板 tab** — 待决 / OKR / 任务 / 收件箱；编排者每轮回复下方「待决 N 件：…」那一行是待决提示行，不叫收件箱 — 出处：本仓库。
- **收件箱** — 面板第四个 tab：决策者随手记下的想法，按项目存在面板本地；点「交给编排者」由编排者转成任务或命令，交过的标「已交」沉底折叠。网页记的存进看板 `inbox/<项目>` 频道（标签 `inbox=open`），编排者转成任务（`create` 后标 `inbox=done task=<KEY>`）或命令（标 `inbox=done`） — 出处：Capture Inbox（GTD，Allen）。
- **网页答复** — 决策者在网页上对待决或等你的回答（`nawaban-web-answer@1`），不解除挂起；编排者核实后自己记已决 — 出处：本仓库（ADR 0003）。

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
_Avoid_: ready queue. 待办 (Backlog) is the index group of never-started tasks, blocked ones included.
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
An open task whose latest `triage:` note is `triage: needs-info — 等你：<question>`: the agent needs the user to answer or act. It is derived, never stored; its session keeps holding it, and a later `triage:` note such as `triage: ready-for-agent` ends the wait. The Herdr panel shows these first, as cards, each with its question. A window Herdr reports blocked (an agent waiting for a permission) is a waiting card too, with "在等你确认" for its question. Questions apply only when the board is the local nawaban board; when work is tracked on GitHub, a pending decision takes their place, while a blocked window still makes a card above the pending decisions: it is a window waiting on you, not a pending decision.
等你是最新一条 `triage:` 备注为 `triage: needs-info — 等你：<问题>` 的未关闭任务：agent 需要用户回答或动手。由数据推导，不单独存储；会话继续持有它，之后再记一条 `triage:` 备注（如 `triage: ready-for-agent`）就不再等。Herdr 面板把它们做成卡片放在最上面，并显示那句问题。Herdr 显示 blocked 的窗口（agent 在等权限确认）也出等你卡，问题写「在等你确认」。问题只用于 nawaban 本地看板模式，在 GitHub 上记账时改用待决；blocked 的窗口在 GitHub 上照样出卡，放在待决上方：它是「窗口在等你」，不是待决。
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
The Claude Code, Codex or Antigravity session working on a task, identified from `CODEX_THREAD_ID` (as `cx-<first 8>`), then `ANTIGRAVITY_CONVERSATION_ID` (as `agy-<first 8>`), then `CLAUDE_CODE_SESSION_ID` (as `cc-<first 8>`), then `NAWABAN_OWNER`. Codex and Antigravity come first because a session started from Claude Code inherits its `CLAUDE_CODE_SESSION_ID`.
窗口是正在做这个任务的 Claude Code、Codex 或 Antigravity 会话，身份依次取 `CODEX_THREAD_ID`（记作 `cx-<前 8 位>`）、`ANTIGRAVITY_CONVERSATION_ID`（记作 `agy-<前 8 位>`）、`CLAUDE_CODE_SESSION_ID`（记作 `cc-<前 8 位>`）、`NAWABAN_OWNER`。Codex 和 Antigravity 排在前面，因为从 Claude Code 里启动的会话会继承它的 `CLAUDE_CODE_SESSION_ID`。
_Avoid_: owner, worker, agent as the holder field.
_Current identifiers_: `tasks.session`; `CODEX_THREAD_ID`; `ANTIGRAVITY_CONVERSATION_ID`; `CLAUDE_CODE_SESSION_ID`; `NAWABAN_OWNER`; `profile()` in `board/src/tasks.ts`.

**Claim**(认领)
Setting a task's session. A claim on a task another session holds fails and names the holder, unless it is a takeover; releasing returns the task to the frontier. Inside Herdr a claim also records the terminal it ran in.
认领是把任务的会话设成自己。别的会话已持有时认领失败并说出持有者，除非显式接手；交还后任务回到可开工列表。在 Herdr 里认领还会记下所在终端。
_Avoid_: assign, start, lock.
_Current identifiers_: CLI `claim`, `claim --take`, `claim --release`.

**Orchestrator**(编排者)
The session the user talks to about a piece of work, declared by the owner typing `/nawaban:orchestrator`, which labels its terminal `role=orchestrator`; one per repository. It starts worker sessions and receives their reports. In Herdr an orchestrator is a terminal with child terminals (`parent` in `terminals()`, the tree in Herdr's sidebar), and its workers are those children, whatever tracker they work from. On the board, a task's orchestrator is the author of its latest `dispatch:` note, else the session holding it, else the session that last claimed it; the panel uses that only for tasks no window holds yet.
编排者是用户就一摊工作直接对话的那个会话，由决策者敲 `/nawaban:orchestrator` 声明，终端打上 `role=orchestrator` 标签；一个仓库一个。它开 worker 会话、收它们的回报。在 Herdr 里，编排者是有子终端的终端（`terminals()` 的 `parent`，即 Herdr 侧边栏里的树），它的 worker 就是这些子终端，不管它们用哪个 tracker。在看板上，一个任务的编排者是它最新一条 `dispatch:` note 的作者，没有时是持有它的会话，没人持有时是最后认领它的会话；面板只对还没有窗口在做的任务用这条。
_Avoid_: leader, 带队会话, 总经理, lead agent, dispatcher, coordinator.
_Current identifiers_: note `dispatch: <worker name>` (agent-center also writes `coord: dispatch {…}`).

**Dispatch**(派活)
Starting a worker on one issue of a GitHub-tracked repository with one command: a worktree off `origin/main`, the worker in it, a brief carrying the acceptance and the one report protocol, and a note on the issue naming the worker's terminal and the acceptance. The reports go to the repository's orchestrator, found by its label.
派活是在 GitHub 记账的仓库里用一条命令给一个 issue 起 worker：从 `origin/main` 拉 worktree，在里面起 worker，派活说明带上验收和唯一的回报格式，issue 上记一条进展写明 worker 的终端和验收。回报发给按标签找到的该仓库编排者。
_Avoid_: 派单, assign.
_Current identifiers_: CLI `dispatch`.

**Decision Request**(待决策项)
A decision put to the owner, hung on the Objective or KR it serves, written as `决策事项：` (the one decision asked), `关联 KR：`, `背景：` (only the facts it turns on), `备选方案：` with at least two `- <方案> ｜ <代价> ｜ 单向门|双向门`, and `建议：`. Its 就绪标准 (Definition of Ready): every part present and not a placeholder, each option with its 代价; the command refuses one that is 未就绪. Readers also take the English `BLUF: / KR: / Context: / Options: / Recommendation:` form. Readers still take the older `【Decision】【Objective / KR】【Context】【Options】【Recommendation】` form.
待决策项是交给决策者拍板的一件事，挂在它服务的 Objective 或 KR 下：决策事项、关联 KR、背景（只写这次决策取决于的事实）、至少两条备选方案（每条写 方案 ｜ 代价 ｜ 单向门或双向门）、建议。缺任何一项，或决策事项、背景、建议只写「无」「none」「-」，就是未就绪（不满足就绪标准），命令就拒；读出来未就绪的不进面板，退回编排者重写。
_Avoid_: 决策卡, 待决卡, decision card, 决策简报, 来龙去脉.
_Current identifiers_: CLI `event --kind ask --kr --context --option --rec`; block `nawaban-ask@1` (`decision` holds 决策事项, `tradeoff` holds 代价, `door` is `one-way`/`two-way`).

**Objective**(目标，O)
Where the work is going, set by the decision-maker alone: qualitative, a direction rather than a number, not a task or an output, important now, measurable by one or two result KRs, not overlapping an existing Objective, said in one sentence. An internal Objective (nawaban's 「编排者不用决策者盯也能把 O 推完」) is legitimate. An agent checks every new or changed Objective against these with the `o-check` skill (O 体检) and answers 是 O, 差一点 or 不是 O with one next step; it never writes one into `okr.toml` on its own.
目标（O）是工作要去的方向，只由决策者定：定性、说方向而不是一个数，不是任务或产出，现在重要，能用一两个结果型 KR 量，和现有 O 不重叠，一句话说清。内部 O（如 nawaban「编排者不用决策者盯也能把 O 推完」）合法。决策者提出或改动 O 时，agent 用 `o-check` skill 照这几条做 O 体检，答「是 O / 差一点 / 不是 O」并给一个下一步；不擅自写进 `okr.toml`。
_Avoid_: 目标值（那是 KR 的 target）, 任务, 里程碑.
_Current identifiers_: `[[objective]] name` in `docs/agents/okr.toml`; CLI `event --kind impact --o`; skill `o-check`.

**Key Result**(关键结果，KR)
A reading of a result the user can perceive, with a target, under one Objective: it measures results, not outputs (「首次会话开播率比旧首页基线高」, not 「Feed 上线子票完成」). The agent drafts KRs from the Objective; the decision-maker approves them and how they are measured.
关键结果（KR）是某个 O 下面、带目标值的一条结果读数：量用户能感知的结果，不量产出（「首次会话开播率比旧首页基线高」，而不是「Feed 上线子票完成」）。agent 按 O 起草，决策者点头才算，量法也由决策者定。
_Avoid_: 指标（泛称）, 交付物.
_Current identifiers_: `[[objective.kr]]` with `name`, `target`, `unit`, `measure` in `docs/agents/okr.toml`.

**OKR progress**(OKR 进度)
The owner's Progress view: each Objective with its KRs, each KR's current value measured now against its target. A repository defines them in `docs/agents/okr.toml`; each KR's `measure` is a command that reads results already produced and prints `<number> <as-of>`. Only a measured value that meets its target counts as met (绿灯; missed is 红灯, stale is 黄灯); a KR with no measure is 未测, and one whose measure fails says why. A KR with `max_age_days` whose reading is older than that is stale and does not count as met. A reading in `%` whose source carries `n=<items>` is a proportion: it is met only when its Wilson 95% bound clears the target (the lower bound for `>=`, the upper for `<=`); a point that meets the target with an interval that does not reads 未定 (`undecided`, with `interval`) and is not met. Each dated reading is kept on the board (`kr_readings`) with its measure hash `def_hash` (the KR's okr.toml entry, the measure code files its command names, and the files its `inputs` globs match, such as eval sets, gold labels and scripts the measure calls indirectly), unless it repeats the KR's latest kept reading value for value; a new hash starts a new series, and trend, missed rounds, stuck and off-their-word are judged inside the newest series only (`series`: its version, since when). A failed measure is kept too and the KR reads 量不了 (`unmeasurable`) until its measure reads again; a failure is no round. `json okr` judges the kept readings against the current definitions without measuring, and lists what the decision-maker must watch (stuck, five missed rounds, waiting on them, an Objective all met awaiting `okr --accept`).
OKR 进度是决策者看的 Progress：每个 Objective 和它的 KR，每条 KR 当场量出的现值对目标。仓库在 `docs/agents/okr.toml` 定义；每条 KR 的 `measure` 是一条命令，只读已有结果，打印「数值 截至」。只有量出来且满足目标的才算达标；没写测量的算未测，测量失败的写明原因；设了 `max_age_days` 而读数比它旧的算过期，不算达标。单位是 `%`、来源里带 `n=<题数>` 的读数是比例读数：Wilson 95% 区间界过线才算达标（`>=` 看下界，`<=` 看上界）；点值过线、区间没过的显示「未定」（`undecided`，附 `interval`），不算达标。带日期的读数连同量法哈希 `def_hash`（okr.toml 该条、measure 命令里点名的量法代码文件，以及 `inputs` 声明的文件：评测集、金标、量法间接调用的脚本，支持 glob）记进看板（`kr_readings`），和该 KR 最新一条一模一样的不再记；哈希一变开新序列，走向、连续未达标、两轮没动、预期不符只在最新序列里算（`series`：口径第几版、从哪天起）。测量失败也记，该 KR 显示「量不了」（`unmeasurable`），直到再量出读数；失败不算一轮。`json okr` 不量，只拿存下的读数对当前定义现算，并列出要决策者盯的（两轮没动、连续 5 轮未达标、等决策者做事、O 全 ✓ 待 `okr --accept` 验收）。
_Avoid_: 进度汇报（口述的）.
_Current identifiers_: CLI `okr`, `okr --accept`, `json okr`, file `docs/agents/okr.toml`, tables `kr_readings`, `okr_accepts`.

**KR impact declaration**(KR 影响声明)
What a ticket registers it will move, before its first pull request: one Objective and, for each KR it changes, its heading (`toward` the target, `away` from it, or `hold`), and whether the change is to the product (`product`, the default), the measure (`measure`) or the gold or data set (`gold`); the CLI adds the KR's latest reading and measure hash. It is registered as the ticket is claimed (`claim --o --kr`) or with `event --kind impact` after; one registered after the ticket's first PR link is late (事后). Closing as done reports only the result: each registered KR's value after and whether it was measured (实测) or expected (预计); heading, reading and measure stay as registered. A KR not listed is unchanged; pure infrastructure declares the Objective 无. The names must exist in the repository's `docs/agents/okr.toml`. In a repository with `okr.toml`, `close --done` refuses a ticket with no declaration, or with registered KRs and no result, and the plugin's merge hook refuses a ticket with no declaration. Declarations written as ↑↓= before v2 are read as late.
KR 影响声明是一张票在第一条 PR 之前登记它要动什么：一个 Objective，它改变的每条 KR 的方向（`toward` 向目标、`away` 背离目标、`hold` 不变），以及改动类别：改产品（`product`，默认）、改量法（`measure`）或改金标、数据集（`gold`）；CLI 自动补上该 KR 当前最新读数和量法哈希。认领时登记（`claim --o --kr`），或认领后用 `event --kind impact` 登记；第一条 PR link 之后才登记的标「事后」。关成完成时只补结果：每条登记过的 KR 的后值和依据（实测或预计），方向、读数、量法版本不再改。没列出的 KR 视为不变；纯基础设施声明 O 为「无」。名字必须在仓库的 `docs/agents/okr.toml` 里存在。有 `okr.toml` 的仓库，没有声明、或登记了 KR 却没补结果的票 `close --done` 被拒，没有声明的票插件的合并 hook 也拦合并。v2 之前用 ↑↓= 写的旧声明一律按事后读。
_Avoid_: 影响评估, impact note.
_Current identifiers_: CLI `claim --o --kr --change`, `event --kind impact --o --kr --change`, `close --done --kr`; blocks `nawaban-impact@2`, `nawaban-impact-result@1` (old `nawaban-impact@1`); table `kr_impacts` (old CLI); hook `hooks/impact-guard.sh` (`hooks/board-impact-guard.sh` for a project on the Vercel Board).

**Impact mismatch**(预期不符)
A declaration the readings contradict. A KR's round is one `okr` run that kept a new reading for it. A registered declaration is judged by the first round after its result, against the round it was registered against, by the KR's target; one that is late, changes the measure or the gold, or was registered under a measure no longer current is not judged. The round moved if its distance to the target changed by at least the noise gate: for two proportion readings, the larger of one item (100/n of the smaller n) and twice the same-commit rerun spread a reading carries as `aa=<points>`; otherwise any change. Toward or away reads 符合 when the round moved that way, 不符 when it moved the other way, and 未定 when it did not move; hold reads 不符 only when it moved away. No result yet, no new round, or no round before the declaration, is no verdict. `json okr` lists, per KR, the declarations its last round has not judged yet (`impacts`: ticket, heading, change, late), each declaration its last round judged (`verdicts`: ticket, heading, verdict), and those that read 不符 (`mismatch`, kept for one version); per Objective, the toward, away and hold counts of those declarations that change the product and are not late, and apart from them the tickets that change the ruler (`rulers`, 改尺子 N 张). Declarations of an Objective with no KR (`--o` alone, or `无`) are not counted.
预期不符是读数与声明对不上。一条 KR 的一轮是一次给它记下新读数的 `okr`。登记的声明由补结果之后的第一轮评判，与登记时那一轮比，按 KR 的 target 判；事后的、改量法或金标的、登记时量法已不是当前序列的，不判。这一轮离目标的距离变化够噪声门才算动了：两轮都是比例读数时，门是 1 题（较小的 n 下 100/n）和读数带的同 commit 重跑波动 `aa=<点>` 的两倍中较大的；否则有变化就算。向目标或背离目标的，往声明的方向动了判符合，往反方向动了判不符，没动判未定；不变的，只有背离目标动了才判不符。还没补结果、没有新一轮、或登记之前没有读数，不判。`json okr` 每条 KR 列出上一轮还没判到的声明（`impacts`：票、方向、类别、是否事后）、上一轮判过的每条声明（`verdicts`：票、方向、判定）和其中判不符的（`mismatch`，保留一个版本）；每个 O 给改产品且不是事后的声明的向目标、背离、不变条数，改量法或金标的票另计（`rulers`，改尺子 N 张）。只声明 O 不带 KR 的（含「无」）不计数。
_Avoid_: 声明失实, 对账失败.
_Current identifiers_: `json okr` fields `impacts`, `verdicts`, `mismatch`; `okr` lines `声明 ↑ ↓ =`, `预期不符`.

**Round**(轮)
One run of the board CLI's `okr`, the orchestrator's self-check; `json okr`, the panel and the web page only read and are no round. Each is kept in `okr/<project>` as `nawaban-okr-round@1`: its number, how many readings it kept, and the KRs that moved toward their target past the noise gate (未定 is no move). A round that kept no reading is idle (空转). A KR's own round, which judges a declaration, is still an `okr` run that kept a new reading for it.
轮是板 CLI 的一次 `okr`，也就是编排者的一次自查；`json okr`、面板、网页只读，不算轮。每轮在 `okr/<project>` 记一条 `nawaban-okr-round@1`：第几轮、新记了几条读数、哪些 KR 往目标动过噪声门（未定不算动）。一条新读数都没记的算空转。评判声明用的是某条 KR 自己的轮，仍指给它记下新读数的那次 `okr`。
_Avoid_: 周期, 迭代.
_Current identifiers_: block `nawaban-okr-round@1`; `okr` line `第 N 轮`, `(空转)`.

**Sprint**(冲刺)
An Objective's rounds since its latest `okr --accept` or `okr --resume <O>`, or since the first round when it has neither.
冲刺是一个 Objective 从最近一次 `okr --accept` 或 `okr --resume <O>` 起的各轮；两样都没有的，从第一轮起。
_Avoid_: 迭代.
_Current identifiers_: blocks `nawaban-okr-accept@1`, `nawaban-okr-resume@1`.

**Hard stop**(硬停)
An Objective whose sprint saw two rounds in a row with no aspirational KR moving, idle rounds included, or reached five rounds without the Objective done (all its KRs met); a round in which the Objective was done stops nothing, and each round keeps the Objectives done as it ran (`done`). Once stopped, `okr` exits 3 and prints `硬停：<O>` on every run until `okr --resume <O>`, and writes a decision-request draft to `~/.nawaban/board/okr-stop/<project>-<O>.md`: what's to decide, the KRs that did not move, the sprint's declarations with their verdicts and each KR's readings, three options (another approach; lower the target and change the measure or data set, both only the decision-maker's), and the recommendation left blank. The orchestrator fills the recommendation and sends it with `event --kind ask`; it is never sent on its own. `--accept` is refused while it is stopped, and `--resume` is refused until a decision request on the Objective or one of its KRs (several KRs separated by 、) was resolved within the sprint. A repository the old CLI keeps (`hooks/route.mjs` prints `old`) has its `okr` refused by the board CLI.
硬停是一个 Objective 的冲刺里连续两轮没有进取型 KR 往目标动（空转的轮也算），或冲刺满 5 轮还没收工（KR 全达标）；某轮跑时已收工的 O，那一轮不触发硬停，每轮记下当时已收工的 O（`done`）。硬停之后每次 `okr` 都退出 3、打印「硬停：<O>」，直到 `okr --resume <O>`；同时把待决策项草稿写到 `~/.nawaban/board/okr-stop/<project>-<O>.md`：决策事项、没动的 KR、冲刺内声明过的票和判定、各 KR 的读数、三条备选方案（换打法继续；降目标、改量法或数据集，后两条只有决策者能定），「建议」留空。编排者补上建议后用 `event --kind ask` 发，草稿不自动发出去。挂在该 O 或它的 KR 上（关联 KR 可以写多条，用「、」隔开）的待决策项在冲刺内被 resolve 之前，`--resume` 被拒；硬停中 `--accept` 也被拒。旧 CLI 记账的仓库（`hooks/route.mjs` 打印 `old`），板 CLI 的 `okr` 直接拒绝。
_Avoid_: 熔断.
_Current identifiers_: CLI `okr --resume <O>`, exit code 3, directory `~/.nawaban/board/okr-stop/`.

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

**Decision Record**(决策记录)
An event recording a choice: `决定：`, `背景：`, `否决方案：<方案> — <原因>`, optional `影响：`, and who decided: the agent or the user. The English `Decision: / Context: / Rejected: / Consequences:` and the older `Question:` / `Verdict:` lines are still read.
决策记录是记录一次选择的事件：决定、背景、否决方案（被否方案和原因）、可选的影响，以及由谁决定（agent 或用户）。英文写法和旧的 Question / Verdict 写法照样读。
_Avoid_: 拍板 as a noun, ask, approval, verdict as a separate record.
_Current identifiers_: `events.kind` = `decision`; CLI `event --kind decision`, `event --by user`; block `nawaban-decision@1` (`verdict` holds 决定 and 影响, `question` holds 背景).

**Link**(链接)
An event pointing at evidence: a pull request URL, an artifact path or an ADR number, optionally prefixed `pr:`, `artifact:` or `adr:`.
链接是指向证据的事件：PR 地址、产物路径或 ADR 编号，可加 `pr:`、`artifact:`、`adr:` 前缀。
_Avoid_: ref, merge_sha field.
_Current identifiers_: `events.kind` = `link`; CLI `event --kind link`.

### Pending decisions

**Decision brief**(决策简报)
The body of a pending decision: what the user needs to decide this without asking anyone, including why it came up, the options and the recommendation.
决策简报是待决的正文：用户不用追问就能拍板所需的全部内容，包括来龙去脉、选项和推荐。
_Avoid_: ask, question, proposal.
_Current identifiers_: `json board` `pending.brief`.

**Pending decision**(待决)
The GitHub form of an open 待决策项: an open issue in which the latest line starting `待决：` is followed by no line starting `已决：`. A line starting `需要你定：` counts as `待决：`. The lines may be in the body or in any comment. It is derived from the issue's text, never from a label. An issue holds at most one pending decision at a time.
待决是一张开着的 issue：最新一个以 `待决：` 开头的行之后，没有以 `已决：` 开头的行。旧写法 `需要你定：` 也算待决。这些行可以在正文里，也可以在评论里。由数据推出，不看标签。一张 issue 同时只挂一件待决。
_Avoid_: waiting on you (local board only), needs-info, blocked, D1-style numbering.
_Current identifiers_: line prefixes `待决：`, `需要你定：`; CLI `brief`; `json board` task `pending` (`brief`, `at`, `progress`).

**Resolution**(已决)
The 决策记录 that ends a 待决策项 on GitHub: the line that ends a pending decision, recording the user's words or the outcome. Only a resolution ends one; a `决定：` line is still recorded but does not.
已决是结掉待决的那一行，记下用户原话或结论。只有它能结案；`决定：` 照常记账，但不结案。
_Avoid_: decided, answered, removing a label.
_Current identifiers_: line prefix `已决：`.

### Board and data

**Board**(看板)
The one SQLite file that holds every task and event.
看板是存放全部任务和事件的那一个 SQLite 文件。
_Avoid_: database as a product term, inbox, modules view.
_Current identifiers_: `.nawaban/nawaban.db`; `NAWABAN_DB`; CLI `init`, `json`.

**Index**(索引)
The md text an orchestrator reads when it starts or after its context is compacted: the open work grouped as waiting on the user (the board only), 停滞 (no activity for 24 hours, with on whom) and 进行中, each with its spec, latest progress and next step (`下一步：` of a 进展同步); the user's 决策记录 of the last 48 hours; the 待办; and a count of the closed. On GitHub it opens with `## 待决`, the 待决策项, oldest first, by issue number and title. It is printed from `json board`'s data each time and never stored (on GitHub the same read rewrites the pending line's cache).
索引是编排者开工或上下文压缩后读的那份 md 文本：开着的事按等你（仅本地看板）、停滞（24 小时没动静，写明停在谁身上）、进行中分组，每件带所属的 spec、最新进展和下一步；48 小时内用户的决策记录；待办；关掉的个数。在 GitHub 上最上面先列 `## 待决`，按提出先后，只写 issue 号和标题。每次从 `json board` 的数据现打，从不存（GitHub 上同一次读取会重写待决提示行缓存）。
_Avoid_: wiki, summary file, status report.
_Current identifiers_: CLI `index`; `NAWABAN_OWNER_NAMES`; on the Vercel Board `nawaban index --project` (`board/src/orchestrator.ts`).

**Pending line**(待决提示行)
The one line under each of the orchestrator's replies that says what waits on the decision-maker: `待决 N 件：<id title> · …｜说「同步」看待决`. Its items are the repository's 待决策项 on GitHub, and the 等你 tasks of the repository's project on the board; nothing else, and never read from the chat. It lists the items this session has not been shown yet, says only `待决 N 件（无变化）` when the set is the same as last time, and is absent when there are none. On GitHub it reads a cache file that every `index`, `brief`, `json board` and `event --kind ask|resolve` rewrites; a cache older than 5 minutes is still shown, marked `· x 分钟前`, while a refresh runs in the background. On the Vercel Board it also says how many of them the web page answered (`，网页已答 M 件`, each such item marked `（网页已答）`) and how many inbox items are open (`；收件箱 K 条`). Only the terminal labelled orchestrator shows it, or, outside Herdr, the session the owner declared with `/nawaban:orchestrator` on a project on the Vercel Board.
待决提示行是编排者每轮回复下方的那一行，写要决策者定的事：`待决 N 件：<号 标题> · …｜说「同步」看待决`。条目只来自 tracker：GitHub 上是本仓库的待决，本地看板上是本仓库项目的等你；不从聊天里读。只列这个窗口还没看过的条目，集合和上次相同时只写 `（无变化）`，没有就不出。GitHub 上读缓存文件，每次 `index`、`brief`、`json board` 和 `event --kind ask|resolve` 都会重写它；缓存超过 5 分钟照样显示，标上 `· x 分钟前`，同时在后台刷新。Vercel Board 上还写网页已答几件（`，网页已答 M 件`，对应条目标 `（网页已答）`）和收件箱开着几条（`；收件箱 K 条`）。只在打了编排者标签的终端出现；没有 Herdr 时，在决策者敲过 `/nawaban:orchestrator` 的那个会话出现（仅 Vercel Board 上的项目）。
_Avoid_: notification, reminder, todo list, inbox, 收件箱 (the panel's 收件箱 tab is the Capture Inbox).
_Current identifiers_: `hooks/inbox.sh` (Stop hook); `~/.nawaban/inbox/`; `hooks/ask-guard.sh` (sends back a decision asked only in chat); on the Vercel Board `nawaban inbox` (`board/src/orchestrator.ts`, no cache; adds `，网页已答 M 件` and `；收件箱 K 条` for what the web page wrote), `~/.nawaban/board/inbox/`, `nawaban page` and `hooks/page-writes.sh` (the web page's answers and inbox items, for the orchestrator's model each prompt), `~/.nawaban/board/orchestrator/<project>` (the session declared orchestrator outside Herdr); `hooks/route.mjs` (which CLI a hook runs).

**Herdr panel**(Herdr 面板)
A read-only view of the board docked in a Herdr window beside the terminals, listing, for the project of the current space, what each orchestrator and its workers are doing. On GitHub the top shows the blocked windows' waiting cards, when there are any, then the pending decisions, each opening its issue, with the window groups folded under them. Claiming, closing and dispatching stay with agents and the CLI.
Herdr 面板是停靠在 Herdr 窗口终端旁的只读看板视图，按编排者列出当前 space 所在项目里每个编排者和它的 worker 在做什么。自上而下三层，所有项目一样：四个 tab：待决（等你卡和待决策项，展开为决策事项、关联 KR、背景、最新进展、备选方案、建议）、OKR（每条 KR 一行 OKR 行，状态用红黄绿灯）、任务（停滞、进行中、待办、已完成四组）、收件箱（决策者记下的想法，可一键交给编排者）。认领、关闭、派活仍由 agent 通过 CLI 完成。
_Avoid_: sidebar, shepherdr, board tab.
_Current identifiers_: `herdr/mods/nawaban-board`; layout block `nawaban`; key `cmd-shift-j`.

**Backup**(备份)
A timestamped copy of the board file under the board directory's `backups/`, kept for 14 days.
备份是看板文件带时间戳的副本，放在看板目录的 `backups/` 下，保留 14 天。
_Avoid_: source checkout as a backup of task data.
_Current identifiers_: CLI `backup`.
