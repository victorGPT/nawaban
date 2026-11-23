# nawaban 迁到 Vercel Board：迁移 spec 与拆票

> 修订：2026-11-20 晚，按决策者「按推荐」定稿（见文末「已定」；与正文冲突处以「已定」为准）。
> 起草：2026-11-20。只读调研，没有改任何仓库，Board 的能力也一条没实跑。
> 依据：Board 仓库 clone 在 `scratchpad/vboard`（`@vercel/board` 0.53.0，npm latest 也是 0.53.0）。下文引用写成 `SPEC:行`、`docs/<文件>:行`（docs 在 `packages/board/docs/` 下），标「仅源码」的说明 docs/SPEC 里没有写，只在源码里看到。
> nawaban 侧读了 GLOSSARY.md、DESIGN.md、PRODUCT.md、skills/nawaban/SKILL.md、docs/adr/0001、hooks/hooks.json、herdr/mods/nawaban-board/main.js，以及 `~/.nawaban/nawaban.db`（只读）。

## Problem

nawaban 是一个 1733 行的单文件 Python CLI，背后是一个手写 schema 的 SQLite。认领没有租约：窗口死了，任务就一直挂在它名下。存储、身份、事件流、依赖、阻塞这些看板底座都是自己维护的，真正属于我们的只有上面那层 OKR、决策卡、待决提示行和派活。

Vercel Board 已经提供了这层底座：任务带租约和 fencing、依赖、awaiting_approval 阻塞、按 schema 校验的结构化 block、watchers、middleware，外加能嵌入的 CLI。决策者 11-20 决定迁过去，nawaban 只保留自己那层。

**迁移时的数据量**（`sqlite3 -readonly`，11-20 读）：

- tasks：open 192 / done 1387 / cancelled 55。open 按项目分：agent-center 134、bzkanbanv2 24、nawaban 22，其余共 12。
- open 任务里：被窗口持有 5 张，等你（最新 `triage:` 是 needs-info）6 张，标题加正文超过 10,000 字的 0 张。
- 记账方式：roubao 用 GitHub（它的 `docs/agents/issue-tracker.md`）；bzkanbanv2 用 nawaban；agent-center 已经改用自建的 workos（`.foreman/workos.db`），所以旧库里 agent-center 那 134 张都是遗留票。
- kr_readings 27、okr_accepts 1、kr_impacts 0。

## Decisions taken（决策者 11-20 已拍板）

1. **方式 A。** `@vercel/board` 作为依赖，锁死版本（`"@vercel/board": "0.53.0"`，不加 ^）。我们的需求全部用它的扩展点实现：schemas、labels、tasks、watchers、middleware、`createApp` 嵌入、handle。代码规范、测试方式、PR 标题都照它的仓库来：
   - PR 标题 `<type>(<area>): <what>`（AGENTS.md:54-100）。
   - CLI 输出风格见 AGENTS.md:229-267。
   - 只用可擦除的 TypeScript（AGENTS.md:335-336）。
   - 每个测试都要「先弄坏它声称测的东西，确认会失败」（AGENTS.md:25-27，test-behavior skill）。
   
   不 fork，它已有的不重写。
2. **全本机。** 用 backend-local（`.board/` 下 SQLite，`vb serve`），不用 Vercel 托管，不 `vercel login`。（板放在固定 dir、用自起的 `board()` 进程，已由决策者确认，见「已定」1、6。）
3. **GitHub 的地位。**
   - 有同事的仓库（roubao，和岳不同共用）：GitHub issue 仍是团队唯一来源，同步进本地板，决策者只看板。
   - 只有决策者的仓库：直接用板。
4. **旧数据。** 只迁开着的票、待决、OKR 读数（kr_readings、okr_accepts、kr_impacts）。旧 `nawaban.db` 留着只读。

## 核实结论：Board 在本机能做什么

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 本地有没有身份 | 有。`vb serve` 签一个 token，调用者是 `local:user:<OS 用户>`，拥有全部权限。agent 用 profile 区分自己，显示为「claude via victor」 | docs/01-cli.md:488-491；docs/03-identity.md:121,129-158；SPEC:2258-2263 |
| 两个并行 agent 怎么分开 | Board 没有会话概念，并行的 agent 必须用不同的 profile。profile 名字母开头，最长 32 位，只能是字母、数字、连字符 | SPEC:757-759；docs/03-identity.md:142-144；docs/03-guides/01-coding-agents.md:122-124 |
| 租约 | 本地可用。默认 15 分钟，可请求 30s 到 1h，本地上限 3600s（`LEASE_CAP_S`，仅源码 src/server/tasks.ts:18-19）。过期后马上可以再认领；local() 在进程内定时写 `task.expired`；过期 claim 的写入一律 `claim_lost` | docs/11-tasks.md:67-71,126-164,357-360；SPEC:3707-3711 |
| tasks block awaiting_approval | 本地可用。`--kind` 可以自己命名，block 会结束 claim，unblock 只有 owner 能做 | docs/11-tasks.md:253-277；docs/04-reference/03-http.md:129-130 |
| schemas | 本地可用，但要 `manage` at `*`，本地用户本来就有（SPEC:1007-1010）。定义注册后不可改、不可删，改就发新版本。值写入时由 API 校验，缺 `required` 字段直接 400，什么也不写入 | SPEC:1247,1372-1420,1486-1493 |
| watchers | local() 在进程内运行 watchers，按线程保序；抛错会重试 5 次，进程重启会丢掉待重试的 | docs/06-watchers.md:175-190；docs/10-local.md:31-33 |
| middleware | 能拦所有 post 和 edit，包括 CLI、handle、watcher 写入，以及 tasks.createMany 的 root。**reactions、labels、deletes 不经过它**，任务状态变化也不算 post | docs/08-middleware.md:28-32,63-69 |
| `vb serve` 能不能挂我们的配置 | **不能。** `vb serve` 没有 sync（docs/01-cli.md:487），也没有挂 watch、middleware 的入口：`serveLocal` 是内部函数，只建 `local()` 加本地 issuer（仅源码 src/cli/serve.ts:76-130）。嵌入式 `createApp` 不含 `serve` 和 `inspect`（docs/01-cli.md:26-30） | 同左 |
| 自起 server 走不走得通 | 文档上走得通。`board({ backend: local({ dir }), authenticate, middleware, watch, sync, url })` 用 node:http 挂在 127.0.0.1（docs/01-mounting.md:103-124；docs/10-local.md:46-51）。`authenticate` 用公开的 `oidcTokens({ local })`（docs/09-access.md:266 只说有 `local` 这个选项；它的形状 `{ issuer, jwks }` 仅源码可见，src/server/tokens.ts:151-160），即 `vb serve` 自己用的那种本地 issuer（SPEC:2258-2259）。必须设 `url`，否则 500 `no_board_url`（docs/01-mounting.md:118）。原装 `vb` 拿 token 有两条路：`BOARD_TOKEN`（docs/03-identity.md:26），或 SPEC:2259-2261 写的 `~/.config/board/local/<hash of url>.json` 文件 | 未实跑，第 1 张票验证 |
| 嵌入 CLI 认 `BOARD_URL` 和 `BOARD_TOKEN` 吗 | 认。不给 `login` 时会读环境变量（仅源码 src/cli/embedded.ts:28-31）。BOARD_URL 的解析见 docs/03-guides/01-coding-agents.md:27-34 | 未实跑 |
| inspector 能不能看我们的板 | 能。`inspect` 给 CLI 指向的任意板起 web UI（SPEC:2268），`vb inspect` 指到我们的 URL 就行 | 未实跑 |
| GitHub sync 不靠 Vercel Connect 行不行 | **出站和认证行，入站不行。** sync 可以用自己的 Chat SDK adapter，不走 Connect（docs/02-sync/04-github.md:197-221）。adapter 收 PAT 形态的 `token`，即 `gh auth token`（仅源码 test/github-webhook.test.ts:12）。但入站只能靠 GitHub 把 webhook 推到 `/webhooks/<key>`（docs/02-sync/01-overview.md:243-267），本地板只听 127.0.0.1（docs/10-local.md:81-83），GitHub 推不进来。还有：GitHub 侧的 root 不会开 issue（04-github.md:95-96）；默认什么也不回写（04-github.md:39-42）；`state`、`tag.*`、`assignee.*` 归镜像所有（04-github.md:155-157）；任务状态不随同步走（docs/11-tasks.md:368-369）；映射前已开的 issue 要等到它有新事件才会进来（04-github.md:159-165）| 替代方案见 T10 与待决 3 |

## Mapping（nawaban → Board）

下表「Board 上的落法」一栏，凡是写成我们自己代码的，都放在新 TS 包里（见下一节）。下面几个简称在全文通用：

- **我们的 server**：`nawaban serve`，即自起的 `board()` 进程。
- **我们的 CLI**：`nawaban`，是 `createApp` 加上我们自己的动词。
- **schema 名**：统一用 `nawaban-<x>@1`。

| nawaban 概念 | Board 上的落法 | 缺口 / 语义差 |
| --- | --- | --- |
| **Board**（一个 SQLite 管全部项目） | 一块本地板，`local({ dir: '~/.nawaban/board' })`（docs/10-local.md:46-51）。**项目对应 channel**，一个仓库一个，名字就是现在的 project 名（`nawaban`、`roubao` …） | Board 默认把 `.board/` 放在 checkout 根（docs/01-cli.md:480）。那样每个 worktree 会各起一块板，和「多项目一块板」冲突，所以改用固定 dir。见待决 1 |
| **Task**（id、title、body） | 任务就是 `tasks create <channel> "<title>\n\n<body>"`。旧 id（`NAWABAN-INBOX-02`）记成 label `key=…`，CLI 按 key 解析到数字 ID。Board 的 ID 由板分配（SPEC:1246） | 正文上限 10,000 字（SPEC:1288）。现有 open 任务没有超限的（0 张）；以后超长的 spec 正文改成附件。非 owner 改 root 会自动 block（kind `edited`，docs/11-tasks.md:310-312），所以只让 owner 改 |
| **Parent / spec** | label `parent=<key>`。spec 本身也是任务 | 无 |
| **Status**：open / done / cancelled | open 对应 waiting、ready、claimed、blocked；done 对应 completed；cancelled 对应 canceled。我们不用 `failed` | **reopen**：completed 是终态（SPEC:3703-3705）。不提供 `close --reopen`，要重做就新建一张 |
| **Blocked by** | `--needs` / `tasks needs`（docs/11-tasks.md:190-211） | **作废不放行。** nawaban 里前置作废就放行，Board 上 canceled 或 failed 的前置不放行（docs/11-tasks.md:198-200）。补法：一个 watcher 监听 `task.canceled`，用 `tasks needs` 从下游的 needs 里摘掉这张。注意只有 owner 改得了，且下游必须没人持有（11-tasks.md:201-204）。watcher 是以 `board:watch:<id>` 身份写的（06-watchers.md:133-137），它不是 owner，所以 watcher 只往收件箱发通知，真正改 needs 的是我们的 CLI `close --cancelled`（以 person 身份执行，SPEC:3636-3638 规定 principal 能改它所有 profile 的任务） |
| **Frontier** | `tasks <channel> --state ready`，再用 `parent` label 过滤 | 先补上面那条，否则作废的前置会把下游挂死 |
| **Session** / **Claim** | profile 是 `cc-<CLAUDE_CODE_SESSION_ID 前 8 位>`，Codex 用 `NAWABAN_OWNER`，显示为「cc-1a2b3c4d via victor」。认领用 `tasks claim <id> --lease 1h` | **租约**是新语义，也是这次要的。代价是：窗口活着但空闲超过 1 小时（比如在等决策者回话），也会丢掉 claim，任务回到 ready。交互式窗口没有 `tasks run` 帮它续租，所以加一个插件 hook（UserPromptSubmit 和 PostToolUse），在租约过半时 `tasks renew` 本窗口持有的任务。claim 存在 `~/.config/board/claims/` 下，按「板、任务、profile」分文件（docs/01-cli.md:1171-1176），所以 profile 必须每个窗口一个 |
| **claim --take** | 不提供。等原租约过期再 claim，零代码 | Board 不能强抢别人的有效 claim，race 时只有一个成功（11-tasks.md:75-76）。这是更严格的语义，可以接受 |
| **Terminal**（ADR 0001） | 认领时同时给 root 打 label `terminal=<HC_TERMINAL_ID>`，面板直接读 | 取代 ADR 0001 的「写在事件正文里」。需要新写一条 ADR |
| **Event: note** | 一条普通 reply。triage 写法照旧：`triage: …` | 无 |
| **Event: decision**（含 `--by user`） | 一条 reply，带 block `nawaban-decision@1`，字段 `{question, verdict, rejected[], by: "agent"\|"user", kr?}`。block 写法见 SPEC:1449-1527，CLI 参数 `--schema` | Board 的 provenance 由服务端写（AGENTS.md:333），`by: user` 是 agent 代决策者录入的数据字段，和现在一样 |
| **Event: link** | reply 加 block `nawaban-link@1`，字段 `{kind: pr\|commit\|artifact\|adr, ref}`。commit 也可以直接用内置的 `git-commit@1`（SPEC:1405） | 无 |
| **决策卡 ask / resolve** | ask 是一条 reply，带 block `nawaban-ask@1`：`required: [decision, kr, context, options, recommendation]`，`options` 是 `{choice, tradeoff, door: one-way\|two-way}` 数组，`minItems: 2`。**「缺字段就拒」由 API 的 schema 校验原生完成**（SPEC:1486-1493）。发卡后同时 `tasks block <id> "<决定>" --kind awaiting_approval`：**被挡本身就是待决**，一张票天然只能挂一件，不要 label、watcher、middleware。resolve 是 `nawaban-resolve@1 {words}` 加 unblock（以 person 身份） | schema 发布后不能改（SPEC:1396-1398），字段想清楚再注册。block 会交还认领（见等你） |
| **等你**（needs-info） | `tasks block <id> "<问题>" --kind needs_input`，面板读 blocked 状态和 reason | **照 Board 语义：block 交还认领**（11-tasks.md:270-272，已定 7）。等人的卡不占认领；解挡后回到 ready，任意窗口接手，上下文靠票上记录。unblock 只有 owner 能做，由我们的 CLI 以 person 身份执行（原窗口死了也能解） |
| **KR 影响声明** | reply 带 block `nawaban-impact@1`，字段 `{objective, krs: [{name, dir: ↑\|↓\|=, before?, after?, basis?: 实测\|预计}]}`。`↑/↓` 必须带前后值和依据，用 schema 的 `oneOf` 表达（SPEC:1411-1412 不含 `if`）。O/KR 名字是否存在于 `docs/agents/okr.toml` 由 **middleware** 检查（文档扩展点，原装 `vb` 写的也拦）（post 必经，docs/08-middleware.md:28-32），middleware 需要 channel 到仓库路径的映射 | schema 不支持 `pattern`（SPEC:1416），格式校验只能靠结构和 enum，名字存在性交给 middleware |
| **close 锁** | 我们的 CLI `close --done` 先查 impact block，没有就拒；插件 PreToolUse hook 拦 agent 直接调 `vb tasks complete|fail|cancel`（决策者自己手敲不拦） | 任务状态写不经过 middleware；不做 backend 包装，避免依赖仅源码可见的 `completeTask`。威胁模型是防忘、不防故意（已定 6） |
| **合并 hook 锁**（impact-guard.sh） | 保留插件 PreToolUse hook，改成读板上的 impact block | 无 |
| **OKR**：okr.toml、measure、读数、轮次 | okr.toml 和 measure 照旧，由我们的 CLI `nawaban okr` 执行。读数写成 block `nawaban-kr-reading@1 {objective, kr, value, asof, commit}`，放在 channel `okr/<project>`，每条 KR 一个线程。accept 是 `nawaban-okr-accept@1`。轮次、stuck、five、wait、accept、mismatch 都是我们 TS 里的纯函数，移植自 cli.py，test_okr.py 的用例一并移植 | Board 没有聚合查询，每次 `json okr` 都要读整个 `okr/<project>` 子树。现在才 27 条读数，量很小 |
| **待决提示行**（Stop hook） | `hooks/inbox.sh` 改成调 `nawaban inbox`，读本项目 channel 里 blocked/needs_input 的任务和 `pending=ask` 的线程。GitHub 项目读同步进来的 issue 线程（见 T10）。**本地读只要几毫秒，5 分钟缓存可以删掉** | INBOX-02（ask-guard）已合（#86），一并移植 |
| **index / brief** | 照搬，数据源换成板 | 无 |
| **dispatch** | worktree 和 `hc run` 的流程不变。原来的 `dispatch:` note 改成 block `nawaban-dispatch@1 {worker, terminal, accept}`，回报照旧发给 `role=orchestrator` 的终端 | 无 |
| **Herdr 面板** | 面板现在写死调用 `python3 ~/nawaban/nawaban/cli.py json …`（main.js:22,40）。只改这两行，换成新 CLI 的 `nawaban json projects\|db\|board\|task\|okr`，**JSON 形状保持不变**，用 logic.test.js 和 okr.fixture.json 做契约测试。`json db` 返回 `~/.nawaban/board/local.db`，供面板监听变化 | 面板现在监听 db 文件；Board 用 WAL，要确认文件变化事件照样触发，不触发就改用 `tail` 推送 |
| **Backup** | `nawaban backup` 复制 `local.db`，必须用 SQLite online backup，不能直接拷文件 | 无 |
| **Claude Code 插件 hooks** | 7 个脚本全保留，内部改成调新 CLI；另加一个续租 hook | 无 |

## 新代码放哪

**推荐：放在 nawaban 仓库里，新建 `board/` 目录，作为一个私有 TS 包（不发 npm），bin 名还叫 `nawaban`。Python 的 `nawaban/cli.py` 在切换完成后删掉。**

理由：

- 插件安装方式不变：`~/.nawaban/plugin` 本来就是这个仓库的 git checkout。hooks、skills、Herdr mod、GLOSSARY、ADR 都在这里，换语言不该换家。
- bin 名不变，SKILL.md、hooks、面板里的 `nawaban <verb>` 写法可以基本保留。
- 方式 A 要求的是「照 Board 的品味写」，不要求「放进 Board 仓库」。另开新仓库的话，插件和 CLI 每次都要跨仓库对齐版本，没有收益。

包内结构，按 Board 的分层（API → `board()` → CLI，AGENTS.md:269-283）：

- `src/server.ts`：`nawaban serve`。启动时注册 schemas（`createSchema` 是幂等的，SPEC:1385-1398）、middleware、watchers，按需启用 sync。`authenticate` 是自写 verifier：认 `~/.nawaban/board/token`（0600）里的 bearer，返回 `{ id: 'local:user:<OS 用户>', kind: 'person' }`（docs/01-board/01-mounting.md「Callers of your own」）。
- `src/cli.ts`：`createApp({ appName: 'nawaban' })`。我们自己的动词（create、claim、close、event、ask、okr、index、brief、inbox、dispatch、json、backup）都走 handle 实现，其余参数原样交给 `createApp`。
- `src/okr.ts`、`src/views.ts`：纯函数。
- `test/`：vitest 跑在 `local({ memory: true })` 上（docs/10-local.md:56-74）。CLI 端到端测试以子进程方式跑。

运行要求：

- Node ≥ 22.18（package.json:16-17）。本机是 v26.8.1。
- 插件更新时要多一步 `pnpm install --frozen-lockfile && pnpm build`。nawaban 的 CLAUDE.md 里「动 schema 先问」的规矩照旧适用。

## 迁移与并行期

按记账方式分两批切。roubao 这类 GitHub 记账的仓库，在 T10 之前整体留在旧 CLI 上，包括它的待决、index、inbox、合并锁和 OKR 表。

1. **阶段 0：并跑（T1 到 T5、T7 到 T9）。** 新板由 launchd 常驻，新 CLI 只给 nawaban 项目自己用（自举）。旧 CLI 和旧 hooks 对其他项目照常工作。
2. **阶段 1：板记账的仓库切换（T6，挡在 T7、T8、T9 之后）。** 涉及 nawaban、bzkanbanv2、agent-center 的遗留票，以及其余几个板记账的小项目。
   - 先 `nawaban backup` 旧库。
   - 跑导入脚本，只迁这些项目。旧库只读打开（`?mode=ro`），可以重复跑：handle 的 post 用 `id` 去重（docs/01-mounting.md:242-245）。
   - 导入内容：open 任务及其 blocker，每张任务最新的 note 和 decision，等你（迁成 blocked/needs_input），以及这些项目的 OKR 三张表。
   - 被持有的任务只能迁成 ready：claim 的 token 迁不过来。原持有者记成 label `held-by=<旧 session>`，原窗口重新认领即可。
   - 旧 CLI 对这些项目拒绝写，提示「已迁到 Board：nawaban …」。读动词保留，用来查历史。GitHub 记账的仓库照常可写。
   - 插件发一个版本：hook 脚本按仓库记账方式分流，板记账的仓库调新 CLI，GitHub 记账的仍调旧 CLI。Herdr 面板同样分流。
   - 改对应仓库的 `docs/agents/issue-tracker.md`。
3. **阶段 2：GitHub 记账的仓库切换（T10）。** 旧 CLI 的 GitHub 写路径（`event '#N'` 等）移植进新 CLI；roubao 接上轮询；它的 OKR 表导入；分流删掉。之后旧 CLI 只剩读历史。

**回退**：切换后一周内，旧库和旧 CLI 都还在。改回插件上一版本就能回到旧板，切换后新写的数据需要手工补回去。这是双向门。

## 风险

- **Board 处于 0.x 实验期。** CHANGELOG 有 217 KB，版本号已经到 0.53。缓解：
  - 锁死版本号，升级单独开 PR。
  - 只用文档写明的扩展点；T1 列一张「非文档符号」清单，目标为空。
  - 升级时先跑我们的测试，再跑 `vb conformance` 对我们的 server（docs/04-reference/05-conformance.md）。
- **自起 server。** 用文档的嵌入方式和自写 verifier，不用 `oidcTokens({ local })`。原装 `vb` 设 `BOARD_URL`+`BOARD_TOKEN` 能否连上，T1 实跑验证。
- **进程内的定时器。** 重启会丢掉待发的定时任务和待重试的 watcher（docs/10-local.md:31-33；06-watchers.md:186-190）。租约不受影响：过期后下一次请求会补写（SPEC:3707-3711）。cancel 摘 needs 是同步写在 CLI 里的，不依赖 watcher。
- **Node 版本。** 要求 ≥ 22.18。launchd plist 里写死 node 的绝对路径，避免 Homebrew 升级换掉 node。
- **本地 sync。** 入站进不来，见待决 3。PAT 形态的 adapter 只在 Board 的测试里出现过，不是文档承诺。
- **schema 不可变**（SPEC:1247）。注册错了只能升 `@2`，读取端要同时认两个版本。T3 先把字段定稿再注册。
- **身份。** 机器上谁能读到 token 文件，谁就是 `local:user`，拥有全部权限（SPEC:2260-2263）。和现在 SQLite 文件的权限模型相同，没有变差。
- **规范来源缺一份。** Board 仓库里的 test-behavior skill 是指向 `apps/software-factory` 的符号链接，clone 里没有这个目录，没读到原文，只有 AGENTS.md:25-27 的一句话概括。T1 前从上游补读。

## Out of scope

- Vercel 托管、`vercel login`、Vercel Connect、Slack 和 Linear 同步。
- 迁移 done 和 cancelled 的历史任务及全部事件流（旧库只读保留）。
- 改 Board 本身、向上游提 PR。确实需要时另开票，按它的 PR 规范走。
- 面板换 UI。只换数据源，DESIGN.md 不动。
- 让 agent 在 GitHub 之外给岳不同发任何东西。

---

## 拆票（10 张，竖切，每张都能端到端演示）

### T1 本地板跑起来，一个任务从建到完成（含租约过期再认领）走通
**What to build**

- `board/` 包骨架，锁 `@vercel/board@0.53.0`。
- `nawaban serve`：`board({ backend: local({ dir: ~/.nawaban/board }), authenticate: <自写 bearer verifier>, url })` 挂在 127.0.0.1:4100，token 写到 `~/.nawaban/board/token`（0600），并用 launchd 常驻。
- `nawaban` CLI 用 `createApp` 嵌入原装命令，从文件里注入 `BOARD_URL` 和 `BOARD_TOKEN`。

**Acceptance**

- 一份实跑记录，依次覆盖：
  - `nawaban whoami` 显示 `local:user:victor`。
  - `tasks create nawaban`。
  - 用 `--as cc-xxxxxxxx --lease 30s` 认领，`read` 显示「cc-xxxxxxxx via victor」。
  - 等租约过期，另一个 profile 能认领，原 profile 的 `complete` 报 `claim_lost`。
  - 新 profile `complete` 成功。
- 原装 `vb` 设上 `BOARD_URL` 后能读同一块板。`vb inspect` 能打开它。
- 用 `launchctl kickstart` 重启 server，数据还在。
- vitest 跑在 `local({ memory: true })` 上覆盖这个流程，先弄坏一处，确认测试会失败。
- 写一份「非文档符号」清单。

**Blocked by**：无

### T2 nawaban 的任务语义在板上成立：key、项目、spec、被挡、可开工、续租
**What to build**

- 动词 `create`（`key`、`parent` label，channel 就是项目）、`block`（needs）、`list --frontier`、`show`、`claim`、`claim --release`、`close --done`、`close --cancelled`。不做 `--reopen`、`--take`。
- cancel 时同步把这张从下游的 needs 里摘掉。
- 认领时打 `terminal` label，并写一条 ADR 取代 0001。
- 插件续租 hook。

**Acceptance**

- 一个 spec 下三张票 A ← B ← C。作废 A 以后 B 进入 frontier。
- 窗口空闲超过租约，任务回到 ready。窗口一直活动，就一直被续租。
- `show` 能看到持有者、被挡、下游、最新进展。

**Blocked by**：T1

### T3 进展、拍板、链接、等你、决策卡都记在板上，缺字段的卡被拒
**What to build**

- server 启动时注册 `nawaban-decision@1`、`nawaban-link@1`、`nawaban-ask@1`、`nawaban-resolve@1`、`nawaban-dispatch@1`。
- 实现 `event --kind note|decision|link`（含 `--by user`）、`event --kind ask|resolve`。
- ask = 带卡片 block 的 reply + `tasks block --kind awaiting_approval`；resolve = reply + unblock（person 身份）。
- 等你 = `tasks block --kind needs_input`（交还认领）；`ready-for-agent` 时 unblock。

**Acceptance**

- 少 `--rec` 的 ask 被拒，板上什么也没写入。
- 已有待决的票再 ask 被拒（任务已是 blocked），resolve 之后放行。
- 等你时认领被交还；unblock 后任意 profile 能认领；原窗口已死也能由 person 解挡。

**Blocked by**：T1

### T4 KR 影响声明，以及没声明就关不了、合不了
**What to build**

- `nawaban-impact@1` 和 `event --kind impact --o --kr`。
- middleware 校验名字存在于该项目仓库的 okr.toml。
- CLI `close --done`：仓库有 okr.toml 却没有 impact 时拒绝；PreToolUse hook 拦 agent 直接调 `vb tasks complete|fail|cancel`。
- `impact-guard.sh` 改读板。

**Acceptance**

- 写错的 KR 名被拒。`↑` 不带前后值被拒。
- 有 okr.toml 的项目里，没有声明就 `close --done` 被拒；agent 窗口里 `vb tasks complete <id>` 被 hook 拦。
- `--o 无` 放行。
- `gh pr merge` 遇到关联票没有声明时被 hook 拒绝。

**Blocked by**：T3

### T5 OKR 进度从板上读：okr、measure、读数、轮次、要你盯、预期不符
**What to build**

- `nawaban okr`：跑 measure，把读数写进 `okr/<project>`。
- `okr --accept`。
- `json okr`：只读板和 okr.toml，输出形状和现在一致。
- 移植 test_okr.py 的用例。

**Acceptance**

- 对 nawaban 仓库，`json okr` 的输出和旧 CLI 对同一批读数的输出做 diff，只差时间戳。
- stuck、five、wait、accept、mismatch 每种至少一条用例，每条都先弄坏、确认失败。

**Blocked by**：T4

### T6 板记账的仓库切换：开着的票、等你、OKR 读数搬到新板，旧 CLI 对它们只读
**What to build**

- `nawaban import --from ~/.nawaban/nawaban.db --project <p>…`，只读打开旧库，可以重复执行。
- 旧 cli.py 对已迁项目加写保护。
- 插件 hooks 和面板按记账方式分流。
- 已迁仓库的 `docs/agents/issue-tracker.md` 改成新调用方式。

**Acceptance**

- 已迁项目的 open 任务数和旧库一致（11-20 的读数：192 张里减去 roubao 的 3 张；以切换当天为准）。
- blocker 边一致。
- 等你的任务（11-20 是 6 张）在新板上全是 blocked/needs_input，reason 是原问题。
- 被持有的任务（11-20 是 5 张）在新板上是 ready，并带 `held-by` label。
- 已迁项目的 kr_readings、okr_accepts、kr_impacts 条数一致。
- 同一个导入再跑一次，什么也不新增。
- 旧 CLI 对已迁项目执行写动词返回拒绝提示，对 roubao 照常可写。

**Blocked by**：T7、T8、T9

### T7 Herdr 面板改看新板，画面不变
**What to build**

- 实现 `nawaban json projects|db|board|task`，形状和现在一致：waiting、terminal、orchestrator、pending 字段都要有。
- main.js 的 CLI 路径改掉。

**Acceptance**

- logic.test.js 和 main.test.js 在新数据源下通过。
- 面板实拍截图：等你卡片、编排者分组、OKR 区都正常显示。
- 板上写入后，面板 2 秒内刷新。

**Blocked by**：T2、T3、T5

### T8 编排者窗口照常：开工索引、待决提示行、编排者 hooks 全部接新板
**What to build**

- `index`、`inbox` 移植，去掉缓存。
- 插件 7 个 hook 改调新 CLI。
- SKILL.md 和 GLOSSARY 的 _Current identifiers_ 更新。

**Acceptance**

- 一个编排者窗口里，SessionStart 打出索引。
- 记一条等你以后，下一轮底部出现「待你决定 1 件」，再下一轮显示「（无变化）」。
- `tests/test_hooks.py` 和 `tests/test_inbox.py` 的场景移植过来并通过。

**Blocked by**：T7

### T9 派活落在新板上
**What to build**

- 移植 `nawaban dispatch`：worktree 加 `hc run` 的流程不变，派活记录改成 `nawaban-dispatch@1`，面板按它找编排者。

**Acceptance**

- 实派一个 worker 做一张票：worker 认领，回报到达 `role=orchestrator` 终端，面板把它挂在该编排者名下。
- 没有活着的编排者时拒绝派活。

**Blocked by**：T2、T3

### T10 GitHub 记账的仓库（roubao）切换：issue 进本地板，决策者只看板
**What to build**

- 按待决 3 的推荐：`nawaban serve` 内跑一个 `gh` 轮询器，每 60 秒拉 roubao 开着的 issue 及新评论，用 handle 幂等写入 channel `roubao`。root 打 `issue=owner/repo#N`、`state` label，评论写成 reply。
- 首次运行全量补导入。
- 面板、索引、待决提示行、brief 的 GitHub 分支改读这些线程，`待决：/已决：` 解析规则不变。
- agent 写 GitHub 仍通过 `nawaban event '#N' …`（移植旧 CLI 的 GitHub 写路径，包括 claim、ask、resolve、impact、close），写完由轮询带回板上。合并锁对 `#N` 改读新板。
- 导入 roubao 的 OKR 三张表，删掉插件和面板里的分流，旧 CLI 只剩读历史。

**Acceptance**

- 在 roubao 某个 issue 上评论一条 `待决：…`，2 分钟内出现在面板和待决提示行。
- 关闭 issue 后，面板显示已关。
- 板上什么也不回写到 GitHub。
- 决策者一整天不打开 GitHub 也能看全待决。
- 分流删掉以后，T8 的编排者场景在 roubao 里重跑一遍，结果相同。

**Blocked by**：T6、T8

---

## 待决（原文；已全部按推荐定，见文末「已定」）

1. **一块板还是每个仓库一块？**
   - 推荐：一块板（`~/.nawaban/board/`），每个项目一个 channel。
   - 理由：面板的「其他项目有几件在等你」、跨项目的 blocked-by、一个 server 进程都依赖一块板。每仓库一块的话，worktree 还会各起一块（docs/01-cli.md:480）。
   - 代价：偏离 Board「`.board/` 放在 checkout 根」的默认。双向门。
2. **agent-center 那 134 张开着的票迁不迁？**
   - 背景：agent-center 已经改用自建的 workos（`docs/agents/issue-tracker.md`、ADR-0248），所以这 134 张是遗留票，没人再在 nawaban 上推。
   - 推荐：不迁，留在旧库只读。这算第 4 条的一个例外，要决策者点头。
   - 另一个选项：照第 4 条全迁，导入时打 `stale=1` label，面板默认折叠。字面上更合第 4 条，但板上多出 134 张没人管的票。双向门。
3. **GitHub 入站：轮询还是 webhook 转发？**
   - 推荐：`gh` 轮询加 handle 幂等写入。
   - 理由：不需要隧道、GitHub App 或 repo webhook 的管理权限，GitHub 仍是唯一写入方，失败了重跑就行。
   - 代价：最多延迟 60 秒，也拿不到 Board 原生 sync 的 `review`、`ci.*` 标签。
   - 另一个选项：官方 sync-github 加 PAT adapter，入站用隧道或 `gh webhook forward` 推到 127.0.0.1。后者是 gh 扩展，处于 beta，没有核实。这样能拿到原生标签和一个线程看完 PR 的整个生命周期，但多一个常驻转发进程，而且 PAT adapter 不是文档承诺。双向门，以后可以换。
4. **roubao 的决策卡写在哪？**
   - 推荐：写在 GitHub issue 上（`待决：` 评论），由轮询带进板。
   - 理由：第 3 条定了 GitHub 是团队唯一来源，岳不同要能看到。
   - 另一个选项：只写在板上，岳不同就看不到决策过程。
5. **server 怎么常驻？**
   - 推荐：launchd 的 user agent，开机自启，崩溃后拉起，日志放 `~/.nawaban/board/serve.log`。
   - 另一个选项：在 Herdr 里固定一个 pane 跑 `nawaban serve`。重启 Herdr 时板会停，面板和 hooks 也跟着失效。
6. **用自起的 `board()` 进程，还是原装 `vb serve`？**
   - 推荐：自起进程（`nawaban serve`）。
   - 理由：只有这样才能挂 middleware（ask 只能有一件、impact 名字校验）和 backend 包装（close 锁），任何客户端（包括原装 `vb`）都绕不过去。
   - 代价：要依赖两个非文档符号：`completeTask` 这个方法名，以及 `oidcTokens({ local })` 的参数形状。
   - 另一个选项：原装 `vb serve` 加一个 sidecar 进程。sidecar 设上 `BOARD_URL`，把 watchers 作为 tail 跑（docs/06-watchers.md:171-174）；校验全部放在我们的 CLI 和插件 hooks 里。好处是不碰任何内部符号，最贴第 2 条原话。代价是没有 middleware 和 backend 锁：直接用 `vb` 的 agent 能绕过校验，要靠 PreToolUse hook 拦。sync 在 BOARD_URL 模式下会抛错（docs/02-sync/01-overview.md:32-33），但待决 3 推荐的是轮询，不受影响。
   - 双向门：两种方案的 CLI、schemas、数据都一样，可以互换。


---

## 已定（决策者 11-20 晚「按推荐」，覆盖上文待决）

1. 一块板 `~/.nawaban/board/`，每项目一个 channel。
2. agent-center 134 张遗留票不迁，旧库只读。
3. GitHub 入站用 `gh` 轮询 60s + handle 幂等写入。
4. roubao 决策卡写在 GitHub issue，轮询带进板。
5. server 由 launchd user agent 常驻。
6. 自起 `nawaban serve`（`board()` + `local({dir})`），只用文档扩展点：自写 bearer verifier、middleware（卡片/声明字段与 O/KR 名字）、watchers。不用 `oidcTokens({local})` 和 backend 包装（`completeTask`）；关单锁 = CLI 拒绝 + PreToolUse hook 拦 agent 直调 `vb tasks complete|fail|cancel`。
7. 等你/待决照 Board 语义交还认领；不做 assign 保留、`pending` label/watcher、一件待决 middleware、`--reopen`、`--take`。

需求依据（第一性原理）：R1 待决唯一来源且每轮摆到眼前；R2 声明由代码强制、只管决策者的窗口、防忘不防故意；R3 不留挂在不干活持有者名下的卡；R4 进度只来自 measure；R5 同事工作流不受约束；R6 只维护 OKR/决策卡/待决提示行/派活；R7 全本机、照 Board 规范。
