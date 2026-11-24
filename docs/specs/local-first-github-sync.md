# 本地先写的 GitHub 同步：roubao 的票在本地板上记，同事要看的推到 GitHub

> 起草：2026-11-25，NAWABAN-MIGRATE-10。只改设计，没有写代码。
> 取代 [board-migration.md](board-migration.md) 的 T10 设计，以及其中和本文冲突的条目（见「推翻了哪些旧条目」）。
> 依据：票上决策记录（11-25，决策者「从第一性原理考虑」，编排者定 A：本地先写）；本仓库 `nawaban/cli.py`、`board/src/`；Board 0.53.0 文档（`~/.nawaban/plugin/board/node_modules/@vercel/board/docs/`）；对 roubao 只读跑的 `gh api`。每条机制标「已实跑」（附命令）或「未实跑」（写明哪张子票验证）。

## Problem

roubao 和岳不同共用，票记在 GitHub issue 上。现在决策者这边每次记账（认领、进展、待决、已决、关票）都是一次 `gh issue comment`：要联网，最慢 30 秒超时（`GH_TIMEOUT_SECONDS`），面板、索引、待决提示行读的是 5 分钟缓存。原 T10 设计是「写 GitHub，轮询带回本地，本地只读快照」，延迟和断网问题都还在。

决策者 11-25 定：本地板是主账本，再和 GitHub 打通。展开成三条：

1. **本地先写。** 记账写进本地板就算成功，不等 GitHub。
2. **事件流并集合并。** 一张票的历史就是本地事件和 GitHub 事件的并集，按事件 ID 去重，按事件自己的时间排序。不做哪边覆盖哪边。
3. **只推同事需要的到 GitHub。** 通过发件箱异步推送，格式沿用 `待决：/已决：/进展：` 等前缀加 marker，岳不同那边的工具不用改。

## 术语

- **同步仓库**：本机配置里列出、由 `nawaban serve` 跟 GitHub 同步的仓库。现在只有 roubao。
- **映射票**：本地板上带 `issue=<owner>/<repo>#<N>` label 的任务，和一个 GitHub issue 一一对应。
- **仅本地票**：同步仓库里没有 issue 的任务，不推送。
- **发件箱**：本地消息上的 `outbox=pending` label，表示这条还没推到 GitHub。不另建表或文件，消息本身就是队列。和「收件箱」（决策者随手记的想法）无关。
- **拉取器 / 推送器**：`nawaban serve` 里的两个循环。

## 1. 编号映射

| 情形 | 本地任务 | 怎么对上 |
| --- | --- | --- |
| GitHub 上的 issue 导入进来 | channel `roubao`；root label `issue=Business-Center-AI-Efficiency/roubao#1730`、`key=ROUBAO-1730` | 导入用的幂等键 `gh-issue-<owner>-<repo>-<N>` |
| 本地新建、没分享 | 正常的 key（`ROUBAO-<自取>`），没有 `issue` label | 无 |
| 本地新建后分享（`nawaban share <KEY>`，或 `create --share`） | 推送器开好 issue 后补上 `issue=…#N` label，key 不变 | issue 正文末尾带 marker `{"uid":…,"kind":"task"}`；拉取时见到这个 uid，就认定是同一张 |
| issue 关了又重开 | 新开一个任务线程，root label `reopened-from=<旧 ID>`，`issue` label 相同 | `#N` 解析到最新那个没关的线程 |

- `#N` 只是别名。CLI 按 cwd 所在仓库得到项目，在该项目的 channel 里找 `issue=…#N` 的 root。`ROUBAO-1730` 和 `#1730` 都能用。
- 一个 issue 同时只能对应一个开着的线程：补 `issue` label 前先查有没有，有就拒绝（`label --if-unset issue`）。
- Board 的 completed 和 canceled 是终态，只有 failed 能 reopen（`docs/01-board/11-tasks.md:96`），所以重开只能开新线程。**已实跑**：roubao 开着的 79 个 issue，被重开过的是 0 个（GraphQL `timelineItems(itemTypes:[REOPENED_EVENT])`，11-25 读），这条路径很少走。

## 2. 拉取

**轮询间隔**：60 秒，沿用已定 3。推送器每推成功一条，马上触发一次拉取，用来确认送达（见第 3 节）。

**增量游标**：每个仓库存在 `~/.nawaban/board/github-sync/<owner>-<repo>.json`，内容是 `{ issuesSince, commentsSince, fullAt }`，都取 GitHub 返回的 `updated_at`，不用本机时钟。

```
GET repos/{o}/{r}/issues?state=all&since={issuesSince - 2m}&sort=updated&direction=asc&per_page=100  (翻页)
GET repos/{o}/{r}/issues/comments?since={commentsSince - 2m}&sort=updated&direction=asc&per_page=100 (翻页)
```

- 两个端点都会混进 PR。**已实跑**：11-25 对 roubao 跑这两条，issues 返回里 #1729、#1727、#1703 带 `pull_request`，comments 返回里有 #1727、#1729 这几个 PR 的评论。issues 端点按 `pull_request != null` 丢掉；comments 端点从 `issue_url` 取号，只收已映射或本轮新导入的 issue 的评论。
- 游标往回退 2 分钟，用来盖住 GitHub 的写入延迟。重叠的部分靠幂等键去重，所以重复拉不会多写。
- 只按 `updated_at` 前进：某一页处理失败，游标就不前进，下一轮重拉。
- 频率：每轮至少 2 次请求，一小时 120 次左右，离 PAT 每小时 5000 次的限额很远。遇到 403 或 429，按 `x-ratelimit-reset` 或 `retry-after` 停下再拉。

**同事事件导入**：每条评论导入成映射票线程里的一条 reply，由同步专用 profile `github-sync` 写，带幂等键：

| 评论 | 幂等键 | 本地写成 |
| --- | --- | --- |
| 末尾带 nawaban marker（`<!-- nawaban {...} -->`，旧 CLI 的 `read_marker` 规则） | `uid-<marker.uid>` | 按 marker 的 `kind` 记成对应事件（`GH_WORDS`：认领、交还、进展、决定、PR、待决、已决、影响） |
| 人手写、带前缀（`_GH_PREFIX_HEADING_BOLD_WORD_WHO_COLON`，含 `**待决**（岳不同）：` 这类写法） | `gh-comment-<id>` | 按前缀记成对应事件 |
| 没有前缀（例如 review 结论） | `gh-comment-<id>` | 普通 reply，不带语义 |

- 每条导入的 reply 都带 label：`at=<created_at>`（事件自己的时间）、`gh.comment=<id>`、`gh.author=<login>`。
- **已实跑**：同一批评论里，岳不同（`yuebutong`）手写的 `待决：@wuxianzhong-gpt …` 在 #1728 上，而且有不少评论不带前缀（`Fable 5.2（medium）审核结论：…`），所以两种都要导入。
- 本地发出、推送后又被拉回来的评论，带着本地写入时的 uid。Board 的幂等规则是「同一 handle 的同一个 id 只写一次」（`docs/04-reference/02-board.md:167`），而本地那条不是 `github-sync` 写的，所以拉取器先按 label `uid=<uid>` 查本地。查到了，只在那条上补 `gh.comment=<id>`，再把 `outbox` 置成 `sent`，不新写。
- **编辑**：评论的 `updated_at` 晚于上次导入，且正文变了，就 `edit` 本地那条。只改 `github-sync` 写的那些；本地发出的以本地为准，GitHub 上改了也不回灌。
- **删除**：增量端点看不到删除。每天对开着的 issue 全量对账一次（第 5 节同一套代码），本地有、GitHub 上没了的导入评论 `delete`，留墓碑。
- **issue 本身**：标题、正文、label、assignee、state 变了，记进 root（标题和正文只在 `github-sync` 是 owner 的导入票上 `edit`）。state 和 assignee 怎么合并见第 4 节。
- **middleware**：`github-sync` 写的消息不做决策卡就绪校验，原文照存。读的一侧照旧用旧 CLI 的解析规则（`_issue_pending`、`_decision_card`）：未就绪的卡照旧退回编排者，不进面板。「防忘不防故意」只管决策者的 agent。

**排序**：读的一侧凡是要取「最新」的（最新进展、最新 triage、最新待决），按 label `at` 排；没有 `at` 的本地消息按 `createdAt`。`at` 相同，再按 GitHub 评论 ID 排，再按 uid 的字典序。不这样排的话，补导入的旧评论落在线程末尾，会被当成「最新」。现在 `replies.at(-1)` 这类读法在 roubao channel 里要改掉，归子票 2。

## 3. 发件箱

**推哪些**（只推映射票；仅本地票什么都不推）：

| 本地事件 | 推到 GitHub 成 | 说明 |
| --- | --- | --- |
| claim / release | `认领：<who>（hc tN）` / `交还：<who>`，加上 `--add-assignee` / `--remove-assignee` | 岳不同那边靠 assignee 和认领评论判断谁在做（`_claims_not_handed_back`、`_issue_task`） |
| note（进展同步） | `进展：…` | `triage:`、`wayfinder:`、`lane:` 这几种记账备注不推 |
| decision | `决定：<question> → <verdict>；否决：<rejected>` | 带 `--kr` 时正文以 `[<KR>]` 开头，和旧 CLI 一样 |
| link | `PR：<url>` | |
| ask | `待决：` 加卡片的五行（`决策事项：/关联 KR：/背景：/备选方案：/建议：`） | 旧解析器 `_DR_FIELD` 能读 |
| resolve | `已决：…` | 只有编排者能记，照旧 |
| impact | `影响：…` | 旧 CLI 一直在推（`GH_WORDS` 里有） |
| close / reopen | `gh issue close --reason completed|not planned` / `reopen` | |
| share（建 issue） | `gh issue create`，正文末尾带 marker | 第 1 节 |

**不推**：派活记录（`nawaban-dispatch`）、triage 备注、网页答复（`nawaban-web-answer`，编排者核实后记的 resolve 会推）、收件箱、OKR 读数、租约的续期和过期。

**格式**：和旧 `gh_post` 一字不差：`<前缀>：<body>\n\n<!-- nawaban {"v":1,"uid":…,"kind":…,"author":…,"terminal":…,"at":…,"body":…} -->`，dash 照旧转义。uid 在本地写入时生成，同时记成那条消息的 label `uid`。这样岳不同机器上的旧 CLI、面板和 hooks 什么都不用改。

**队列**：本地写的时候，同一次写里给消息打上 `outbox=pending`、`uid=…`、`at=…`。推送器每轮（60 秒，或者有本地写入通知时马上）读 `--label outbox=pending`，然后：

1. 按 issue 分组，组内按 `at` 先进先出。某个 issue 的队头失败了，这个 issue 后面的就不推（保证 `已决` 不会跑到 `待决` 前面），别的 issue 照推。
2. 每次 POST 之前，先把 `outbox.try` 加 1。如果原来已经大于 0，说明上次可能发出去了但没来得及记下来，就先在该 issue 上找有没有 marker uid 相同的评论（拉评论时带 `since=<at - 2m>`）。找到了，直接记成已送达。
3. POST 返回 2xx 后，记 `gh.comment=<id>`，并 `label outbox=sent --if outbox=pending`。
4. 是不是真的送达，以拉取器见到自己的 uid 为准（第 2 节），POST 的返回只是快路径。`gh issue comment` 本身不幂等，所以不能只看返回码判断要不要重发。

**重试**：

| 失败 | 处理 |
| --- | --- |
| 断网、5xx、超时 | 退避 1、2、4、8、16 分钟，最长 30 分钟，一直重试，不丢 |
| 403 / 429 限流 | 等到 reset 时刻再推 |
| 401 / token 失效 | 整个推送器停下，等 `gh auth` 恢复；每轮重试一次 |
| 404 / 410 / 422（issue 删了、转移了、正文不合法） | 标 `outbox=failed`，写上原因，不再重试；在待决提示行露出来 |

**推送账号**：配置里写死账号（roubao 是 `wuxianzhong-gpt`），每次用 `GH_TOKEN=$(gh auth token --user <账号>)` 推。不沿用旧读路径「换个不活跃的 login 再试」的做法（`_retry_as_an_inactive_login`），以免拿错身份写进同事的仓库。

## 4. 状态事件的合并

总规则：开关和认领也是事件，和其他事件一起取并集，按 `at` 折叠出当前状态。平局按第 2 节的排序。

| 状态 | 本地 → GitHub | GitHub → 本地 | 并发冲突 |
| --- | --- | --- | --- |
| **关票** | 本地 `close` 先过关单锁（roubao 有 `okr.toml`，要先声明 impact），本地任务马上 complete 或 cancel，再推 close | 导入的 issue 变成 closed：`github-sync` 认领 30 秒，然后 complete（`stateReason=completed`）或 cancel（`not_planned`） | 两边都关：先到的生效，后到的什么也不改 |
| **重开** | 本地不提供 `--reopen`（已定 7）；要重开就在 GitHub 上重开 | 按第 1 节开新线程，`reopened-from=<旧 ID>` | 关和重开的折叠结果以 `at` 最晚的为准 |
| **认领** | Board 租约加推 `认领：` 和 assignee | 同事的 `认领：` 评论或 assignee：打 label `held-by=gh:<login>`，任务不进 Board 租约 | 本地 claim 遇到 `held-by=gh:*` 一律拒绝，提示「<login> 认领中，先在 #N 上说好」（已定 7 不做 `--take`）。两边同时认领：拉回来后按 `at` 早的算，本地输了就由推送器 release 并推 `交还：`，再记一条进展说明原因 |
| **交还** | 租约结束（release、block、过期）都推 `交还：` 并 remove assignee | 同事 `交还：` 或去掉 assignee：清掉 `held-by=gh:<login>` | 无 |
| **待决** | 本地 ask：任务 block 成 `awaiting_approval`，推 `待决：`；第二件 ask 由本地拒绝，照旧「一个 issue 只放一件」 | 同事的 `待决：`：`github-sync` 以 owner 身份 block 成 `awaiting_approval`（导入票的 owner 就是 `github-sync`；本地建的票，block 由 owner 的 profile 来做） | 两边同时提了待决：都留下，当前待决取最晚那件没决的，和旧 `_latest_unresolved_ask_line` 一样 |
| **已决** | 编排者 resolve：unblock，推 `已决：` | 导入 `已决：`：unblock | 无 |

## 5. 首次全量导入

`nawaban serve` 起来时，如果游标文件里没有 `fullAt`，先跑一遍全量，再进入增量：

1. `gh issue list --state open --limit 1000`，加上最近 2 天关掉的（`GH_RECENT`，和旧读路径的范围一样），丢掉 PR。
2. 每个 issue 建任务（幂等键 `gh-issue-…`）。评论用 `gh api --paginate repos/{o}/{r}/issues/{N}/comments` 拉全，按第 2 节导入。
3. 父子关系从 `parent` 字段、标题后缀 `（#N-xx）`、正文 `属于 #N` 解析（`_parent_of`），记成 `parent=ROUBAO-<N>`；GitHub 原生的 blocked-by 记成 Board 的 needs。
4. 游标取全量开始的时刻（GitHub 响应头里的 `date`）往回 2 分钟，写入 `fullAt`。
5. 以后有新评论落在没导入过的旧 closed issue 上，就按需导入那个 issue。

再跑一遍什么也不新增（幂等键）。每天的对账（第 2 节的删除处理）就是重跑 1 到 3 步。

## 6. GitHub 不可用时

- **写**：照常成功，什么都不等。发件箱里的条目越积越多。
- **读**：面板、索引、待决提示行都读本地板，照常可用，只是看不到同事新写的东西。
- **露出来**：拉取超过 3 轮（3 分钟）没成功，或者发件箱最早一条超过 5 分钟没推出去，待决提示行和面板项目行末尾加一句：`GitHub 同步停在 HH:MM（<原因>）｜待推 N 条`。`outbox=failed` 的条目单独计数：`推送失败 K 条，见 nawaban sync status`。
- **`nawaban merge`**：本来就要 GitHub，照旧失败退出，不受这套机制影响。
- **恢复后**：游标没前进，自动补拉；发件箱按顺序补推。两边都只做并集，所以断网期间两边各自写的东西都留着，不会互相覆盖。

## 7. 和现有 `nawaban event "#N"` 写路径怎么切

现在：roubao 的 `docs/agents/issue-tracker.md` 让 agent 跑 `python3 ~/.nawaban/plugin/nawaban/cli.py event '#N' …`，旧 CLI 直接 `gh issue comment`。两台机器共用这份文档，文档首个标题里有「GitHub」这个词，它同时是分流开关（`tracksOnGithub`、`github_root`）。

切换以后**按机器**分流，不按文档分流：

1. 本机有 `~/.nawaban/board/github-sync.json` 且里面列了这个仓库，而且板能连上：旧 CLI 的 GitHub 写动词（claim、event、close）原样转给 `board/src/cli.ts`，由它解析 `#N`，写进本地并打上发件箱 label。
2. 本机没有这份配置（岳不同的机器），或者板连不上：仍然走旧的直接 `gh` 写。写出去的评论带 marker，拉取器会带回本地。并集合并保证这条降级路径不会写出两份。
3. roubao 的 `issue-tracker.md` 一个字都不用改，命令照旧。首个标题里的「GitHub」继续留着，因为岳不同那边还靠它分流。
4. 读的一侧（面板、索引、待决提示行、brief、网页）对同步仓库改读本地板，删掉 `server.ts` 里的 `githubView` / `answerOnGithub` 和旧 CLI 的 `json board` 读法，以及 5 分钟的缓存。删的范围只限本机有同步配置的仓库。
5. 合并锁（旧 `merge_gate`、`board/src/merge.ts`）对 `#N` 改读本地板。
6. 拦手写前缀 `gh issue comment` 的 hook 保留。

## 推翻了哪些旧条目

- board-migration.md「Decisions taken 3」：「GitHub issue 仍是团队唯一来源」改为「本地板是主账本，映射票和 GitHub 双向同步」。
- 已定 3：轮询 60 秒和幂等写入照旧；「GitHub 是唯一写入方」作废。
- 已定 4：「roubao 决策卡写在 GitHub issue」改为「先写本地，映射票由发件箱推成 `待决：` 评论」，岳不同仍然看得到。
- T10 的写路径「agent 写 GitHub 仍通过 `nawaban event '#N'`，写完由轮询带回」和成功判据「板上什么也不回写到 GitHub」，都由本文取代。

## 待决策者确认

- **「同事需要的」怎么界定**：本文的推荐是，映射票上的事件按第 3 节全推（这是岳不同的旧 CLI 读状态的下限，少推一种，他那边就会重复认领或重复提待决）；同步仓库里新建的票默认只在本地，碰到岳不同那条线（前端展示、片源接入与播放、埋点）、共享契约（`packages/shared`、SSE 事件）或要他动手的，用 `--share` 开 issue。另一个选项是同步仓库新建的票一律分享，等于 GitHub 上什么都有，只是写入改成异步。

## 拆票

竖切，每张都能单独演示。子票 key 是 NAWABAN-MIGRATE-10-01 到 -05，parent 是 NAWABAN-MIGRATE-10。

| 子票 | 做什么 | 被挡 |
| --- | --- | --- |
| -01 拉取影子 | 第 2 节和第 5 节：全量导入、60 秒增量、同事事件导入、每日对账，写进 channel `roubao`。现有读路径不动，另写一个对账脚本，拿它和旧 `json board` 比待决、开关、认领人 | NAWABAN-MIGRATE-06 |
| -02 读切换 | 第 7 节第 4 条：面板、索引、待决提示行、brief、网页对同步仓库改读本地板，按 `at` 排序，加上同步滞后提示；删掉旧的 GitHub 读路径和缓存 | -01 |
| -03 发件箱与写切换 | 第 3、4 节和第 7 节第 1、2、5 条：本地先写，推送器，旧 CLI 按本机配置转发，合并锁读板，状态冲突规则 | -02 |
| -04 仅本地票与分享 | 第 1 节的「本地新建」「分享」两行：`create` 默认只在本地，`share` 开 issue | -03，以及「待决策者确认」那一条 |
| -05 收尾 | 导入 roubao 的 OKR 三张表；删掉插件和面板里按文档标题的分流（只限有本机配置的仓库）；GLOSSARY 加「发件箱」「映射票」；T8 的编排者场景在 roubao 重跑一遍；在 roubao 的 issue 上知会岳不同（他那边什么都不用改） | -03、-04 |

## 还没实跑的，由哪张子票验证

| 机制 | 风险 | 子票 |
| --- | --- | --- |
| `github-sync` profile 写的消息，用 `--idempotency-key` 重跑不重复 | 幂等键按 handle 计；profile 一变就会重复写 | -01 |
| middleware 按 profile 放过导入的消息 | middleware 拿不到 profile 的话，未就绪的卡会被拒，导入就断了 | -01 |
| `github-sync` 以 owner 身份 block、unblock，以及先认领再 complete | 导入票的 owner 由谁来当 | -01 |
| 给 reply 打 label，以及用 `--if` 做 compare-and-set | 如果 Board 只许 root 打 label，发件箱就得换个地方存 | -03 |
| 推送器在 `nawaban serve` 里跑，进程重启后靠 label 续上 | watcher 重启会丢掉待重试的（`docs/01-board/06-watchers.md`），所以不能用 watcher 实现 | -03 |
| 旧 CLI 在板连不上时降级成直写，评论再被拉回来 | uid 对不上就会多出一条 | -03 |
| Board 的 `/sync/imports` 能让同事的评论显示成他本人写的 | 可选的改进；本文先用 `gh.author` label | 不做，等需要时再说 |
