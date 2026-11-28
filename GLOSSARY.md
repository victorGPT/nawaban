# nawaban

人和 agent 共用的名词，括号里是英文名。

## 票

**票**(Task)
有标题和 markdown 正文的工作单元，正文写要做什么和成功判据（Acceptance criteria）。spec 也是票。
_Current identifiers_: `create`, `show`, `list`

**可开工**(Frontier)
没人认领、前置都已关闭的未关闭票。
_Current identifiers_: `list --frontier`

**状态**(Status)
未关闭、完成或作废，变化记进事件。
_Current identifiers_: `close --done`, `close --cancelled`, `close --reopen`

**等你**(Waiting on you)
挂起等人回答的票，挂起交出认领。`resolve` 记提炼后的结论，不记原话，票回到挂起它的身份。
_Current identifiers_: `event <票> wait`, `event <票> resolve`

**事件**(Event)
票日志里只增不改的一条：note、status、decision、link。
_Current identifiers_: `event --kind`

## 会话

**窗口**(Session)
做票的会话。身份依次取 `CODEX_THREAD_ID`、`ANTIGRAVITY_CONVERSATION_ID`、`CLAUDE_CODE_SESSION_ID`、`NAWABAN_OWNER`、本机用户名。
_Current identifiers_: `profile()`

**认领**(Claim)
把票的会话设成自己。别人持有时失败，`--take` 才接手。
_Current identifiers_: `claim`, `claim --take`, `claim --release`

**编排者**(Orchestrator)
用户对话的会话，用 `/nawaban:orchestrator` 声明，一个仓库一个。它派 worker、收回报。
_Current identifiers_: `status`, `dispatch`, `merge`

## 决策

**待决策项**(Decision Request)
交决策者拍板的一件事，简称待决。要写决策事项、关联 KR、背景、至少两条「方案 ｜ 代价 ｜ 单向门或双向门」、建议。缺项或占位就拒。已决只记提炼后的结论。
_Current identifiers_: `event --kind ask`

**决策记录**(Decision Record)
一次选择：决定、背景、否决方案和原因，可选影响。
_Current identifiers_: `event --kind decision`

## OKR

**目标**(Objective)
决策者定的方向，定性，一句话。agent 用 `o-check` 体检，不擅自写进 `okr.toml`。

**关键结果**(Key Result)
O 下带目标值的结果读数。agent 起草，决策者点头。

**OKR 进度**(OKR progress)
`okr` 量每条 KR 的现值对目标：达标、未达标、过期、未测。O 收工后用 `okr --accept` 验收。
_Current identifiers_: `okr`, `json okr`, `docs/agents/okr.toml`

**KR 影响声明**(KR impact declaration)
第一条 PR 前登记要动的 O 和每条 KR 的方向（toward、away、hold）。关成完成时补后值（实测或预计）。纯基础设施写 O 为「无」。
_Current identifiers_: `claim --o --kr`, `event <票> impact`, `close --done --kr`

**硬停**(Hard stop)
O 连续两轮 KR 没动，或满 5 轮没收工。`okr` 随后退出 3，直到 `okr --resume <O>`。

## 数据

**看板**(Board)
存全部票和事件的 SQLite：`~/.nawaban/board/local.db`。

**同步仓库**(Synced repository)
`github-sync.json` 列的 GitHub 仓库。issue 成票 `<项目>-<N>`，CLI 不认 `#N`，改 issue 用 `event note`。
