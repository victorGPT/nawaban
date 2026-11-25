# 本地先写的 GitHub 同步：原生 sync-github，加本机轮询器和推送过滤

> 2026-11-25 改写，NAWABAN-MIGRATE-10。上一版（PR #150）是全部自建：拉取器、发件箱、去重、作者都自己写。决策者 11-25 定「不要造轮子，能用 Board 那套就用那套」，[vb-native.md](vb-native.md) 调研的结论是原生 `@vercel/board/sync-github` 在本地板上能用，所以这一版改成原生为主，只自建原生做不到的三件：轮询入站、推送过滤与重推、开关票和开 issue 往外推。
> 依据：vb-native.md（下文写成「VN §n」），Board 0.53.0 文档 `docs/02-sync/`（在 `board/node_modules/@vercel/board/` 下），票上决策记录（11-25 的 1408、1425、1429）。

## Problem

roubao 和岳不同共用，票记在 GitHub issue 上。决策者这边每次记账都要一次 `gh issue comment`，要联网；面板读的是 5 分钟缓存。决策者 11-25 定本地板是主账本，和 GitHub 打通：本地先写，事件流取并集合并，只把同事需要的推到 GitHub。

## 原生负责什么，我们加什么

| 部分 | 谁做 | 说明 |
| --- | --- | --- |
| 把 issue 和评论写成板上的线程（root 带 `issue=<owner>/<repo>#N`、`state`、`tag.*`、`assignee.*`） | 原生 | `docs/02-sync/04-github.md`「Events」「State labels」 |
| 去重（按评论 ID，不按投递 ID） | 原生 | VN §2 实跑 |
| 作者（导入的 reply 署名 `github:user:<id>`） | 原生 | VN §2 实跑 |
| 编辑、删除（收到事件时） | 原生 | 04-github.md Events 表 |
| 推送账号自己写的评论不导入回来 | 原生 | VN §2 实跑；本地发出的东西不会转一圈再回来 |
| 推送的格式（前缀加 marker） | 原生 `render` | VN §2 实跑 |
| 推送按线程排队、按顺序 | 原生 | `docs/02-sync/01-overview.md` |
| **入站** | **自建：本机轮询器** | 原生只收 webhook（VN §1），本地板只听 127.0.0.1，决策者 11-24 定网页只在 tailnet 内，不开公网入口（决定 1425） |
| **推哪些** | **加一层：sync 函数里过滤** | 原生默认什么也不推 |
| **断网后补推** | **加一层** | 原生重试 5 次后放弃，进程重启也丢（VN §2） |
| **开关票、assignee、开 issue 往外推** | **自建** | 原生不外推 label 和任务状态，也不能由 root 开 issue（VN §2） |
| 导入的 issue 变成任务、前缀变成待决/已决 | 加一层 | 原生只存原文 |

## 1. 配置

`nawaban serve` 读 `~/.nawaban/board/github-sync.json`。文件不在，就不挂 sync，行为和现在一样。

```json
{ "repos": { "Business-Center-AI-Efficiency/roubao": "roubao" }, "reader": "wuxianzhong-gpt" }
```

- `repos`：仓库到板上 channel。只同步 issue，不同步 PR（PR 的同步以后再说，VN §3 最后一行）。
- `reader`：轮询用哪个 gh 账号的 token 读，只读。
- webhook secret 由 serve 首次启动时生成，存在 `~/.nawaban/board/github-webhook-secret`（同 `token` 文件的做法）。
- 推送身份：就用 agent 现在写 GitHub 的 `wuxianzhong-gpt`，不建 GitHub App，也不开专用账号（决策者 11-25 问「能不能两个都不建」，临时板实测可以，见第 4 节「推送身份」）。
- **只推公司仓库**：只有和同事共用、记账在 GitHub 上的仓库（现在只有 roubao）才写进 `github-sync.json`，也只有它们推送。个人仓库（nawaban、bzkanbanv2 等只有决策者的）记账本来就在板上，不进 `github-sync.json`，什么都不推。

## 2. 入站：本机轮询器

轮询器跑在 `nawaban serve` 进程里，每 60 秒一轮：

1. 用 `reader` 的 token，跑 `GET repos/{o}/{r}/issues?state=all&since=<游标-2m>&sort=updated&direction=asc` 和 `GET repos/{o}/{r}/issues/comments?since=<游标-2m>&sort=updated&direction=asc`，翻页拉完。两个端点都会混进 PR（上一版实跑），issues 按 `pull_request` 丢掉，评论只留 issue 上的。
2. 把每条结果拼成 GitHub 的 webhook 载荷（REST 的 issue、comment 对象和 webhook 里的同一个形状），用 secret 做 `x-hub-signature-256`，直接交给本进程的 `team.fetch`，路径是 `/api/board/webhooks/github`。不经过网络。
   - issue 第一次见到：`issues` / `opened`；如果它已经关了，再补一条 `closed`。
   - 开关变了（和上一轮记下的不一样）：`closed` 或 `reopened`。
   - 其他变化：`edited`，原生拿它对齐标题、`tag.*`、`assignee.*`。
   - 评论：`issue_comment` / `created`；`updated_at` 晚于 `created_at` 的再补一条 `edited`。重复送不会多写（原生按评论 ID 去重）。
3. 所有载荷都返回 2xx，才把游标推进到这一批最大的 `updated_at`。有一条失败，游标不动，下一轮重来。游标用 GitHub 的时间，不用本机时钟，往回退 2 分钟盖住 GitHub 的写入延迟。
4. 游标和每个 issue 上一轮的开关状态存在 `~/.nawaban/board/github-sync/<owner>-<repo>.json`。

**首次全量**：游标文件不在时，先拉开着的 issue 和最近 2 天关掉的，每个 issue 的评论按 issue 翻页拉全，按上面的规则送进去，再写游标。以后有评论落在没见过的旧 issue 上，原生会自己去取那个 issue（04-github.md「Comments on PRs the board hasn't seen」）。

**sync 函数（入站这一侧）**：`direction === 'in'` 时 `import(channel)`。

**botUserId**：原生把 `botUserId` 写的评论当成自己发的，不导入。决策者的 agent 都用 `wuxianzhong-gpt` 写 GitHub，所以 `botUserId` 绝不能是这个账号的 ID（VN 结论 4）。`botUserId` 一直填一个不存在的 ID，所有人的评论都导入；推送也用 `wuxianzhong-gpt` 之后仍然这样填，推出去的评论靠原生的同步映射认回，不靠 `botUserId`（第 4 节）。

**不往 GitHub 写**：没定推送身份之前，serve 进程里对 `api.github.com` 的非 GET 请求一律拒绝（GraphQL 的 `viewer` 查询也是 POST，所以 `botUserId` 必须显式给，原生就不会去查）。轮询器用 `gh api` 只发 GET。

**删除**：增量端点看不到删除。每天对开着的 issue 全量重拉一次评论，本地有、GitHub 没了的，补发 `deleted`。放在 -08。

## 3. 导入的 issue 变成任务、前缀变成事件（加一层）

在 sync 函数的入站一侧（或者入站之后的 tail）加：

- issue 的 root 导入后，`tasks.create({ re: root })` 转成任务，加 `key=ROUBAO-<N>`（`import(channel, { labels })`）。`#N` 和 `ROUBAO-N` 都解析到它。
- 评论按旧 CLI 的规则解析：带 marker 的按 marker 的 `kind`，手写的按前缀（`_GH_PREFIX_HEADING_BOLD_WORD_WHO_COLON`）。`待决：` → 任务 block 成 `awaiting_approval`；`已决：` → unblock。不带前缀的就是普通 reply。
- `state=closed` → complete（`stateReason=completed`）或 cancel（`not_planned`）。任务正被持有或挂着待决、complete 不了的，先由面板按 `state=closed` 显示已关，下一轮再试。
- 重开：任务 completed 之后不能 reopen（只有 failed 能），所以 `state` 从 closed 回到 open 时新建一个任务，带 `reopened-from=<旧 ID>`。roubao 开着的 79 个 issue 里被重开过的是 0 个（上一版实跑）。
- middleware（`impactNames` 和决策卡校验）按作者前缀 `github:` 放行导入的消息，原文照存；读的一侧照旧用旧 CLI 的规则判断待决有没有就绪。
- 排序：导入的评论在板上的时间就是导入的时间，补导入的旧评论会落到线程末尾。取「最新」（最新进展、最新待决）时按 GitHub 的 `created_at` 排，原生的导入记录里有平台时间就用它，没有的话由 -07 在导入时补一个 `at` label。

## 4. 出站：推送（只推公司仓库）

**推哪些**（sync 函数 `direction === 'out'` 里过滤，只推映射到 issue 的线程）：认领和交还、进展同步（`triage:`、`wayfinder:`、`lane:` 这几种记账备注不推）、决策记录、PR 链接、待决、已决、影响声明。不推：派活记录、triage、网页答复、收件箱、OKR 读数、租约续期。

**格式**：`render` 出和旧 `gh_post` 一字不差的「前缀：正文」加 marker `<!-- nawaban {...} -->`，岳不同机器上的旧 CLI 什么都不用改。

**补推**：原生重试 5 次后放弃，失败原因留在消息的 `undelivered` 里。serve 每轮扫 `undelivered` 不为空的消息补推；具体怎么补推（原生没有 redeliver 入口）由 -09 先实跑定。

**状态外推**（自建）：本地关票、重开、认领时，用 adapter 的 octokit 调 `issues.update`、`addAssignees`、`removeAssignees`。本地新建的票要分享，调 `issues.create`，再 `vb sync <id> github:<owner>/<repo>:issue:<N>` 把线程挂上去。

**写路径切换**：`nawaban event '#N'`、`claim '#N'`、`close '#N'` 先写本地板，再由 sync 推出去。旧 CLI 在本机有 `github-sync.json` 时转给板；没有的（岳不同的机器）照旧直写 GitHub，轮询器再带回来。网页记已决（`server.ts` 调 `cli.py`）改成先写板。

**推送身份**：用 `wuxianzhong-gpt`，`botUserId` 仍填不存在的 ID。11-25 在临时板上实测（内存板，GitHub API 打桩，不碰真 GitHub），一来一回的结果：

| 情形 | 结果 |
| --- | --- |
| 同一账号绕过板直写 GitHub 的评论 | 照常导入，作者 `github:user:<id>` |
| 板上写的一条推出去（POST 成功），再以 `issue_comment created` 拉回来 | 原生按「评论 ID ↔ 板消息」的同步映射认出是同一条，不多一条，原文不变 |
| 同一条再以 `created` 送一次 | 还是不多 |
| 同一条以 `edited` 拉回来 | 不多一条，也不再推回 GitHub（只有那一次 POST），但板上那条原文被改成推出去的样子（带前缀和 marker）。轮询器只在 GitHub 上真被编辑过（`updated_at` 不等于 `created_at`）时才送 `edited`，正常推送碰不到 |
| GitHub 收下了但响应丢了（桩先回 502） | 原生重试，GitHub 上出现两条一样的评论；拉回来时有映射的那条认成同一条，没映射的那条被当成新评论导入，板上多一份 |

结论：正常一来一回不重复，不建新身份。最后一种和用哪个身份无关：换专用账号并把 `botUserId` 设成它，板上不会多，但 GitHub 上仍是两条。-09 里补两处（估计 sync 函数加 40 行左右，外加两条回归测试）：
- 认回声：入站时评论末尾带 nawaban marker，且 marker 的 `uid` 是板上已有消息的，就不 `import`。
- 重推前先查：推送失败要重试前，先在该 issue 最近的评论里找同一个 `uid`，找到就不再 POST，这和第 3 节「补推」是同一处代码。

## 5. 开关和认领的合并

开关和认领也是事件，两边取并集，按事件时间折叠：

| 状态 | GitHub → 本地 | 本地 → GitHub（-10） | 两边同时改 |
| --- | --- | --- | --- |
| 关票 | 原生更新 `state`；第 3 节转成 complete 或 cancel | octokit 关 issue | 先到的生效，后到的什么也不改 |
| 重开 | 第 3 节，新建任务 | 本地没有 `--reopen`（已定 7） | 以时间晚的为准 |
| 认领 | 原生维护 `assignee.*`；本地 claim 时如果有别人的 `assignee.*` 就拒绝，提示先在 issue 上说好 | 认领时推 `认领：` 并加 assignee | 时间早的算；本地输了就 release 并推 `交还：` |
| 待决、已决 | 第 3 节 | 第 4 节 | 当前待决取最晚那件没决的，和旧 `_latest_unresolved_ask_line` 一样 |

## 6. GitHub 不可用时

- 写：照常写进本地板，不等网络。
- 读：面板、索引、待决提示行读本地板，照常可用。
- 轮询失败：游标不前进，恢复后自动补拉。连续 3 轮失败，面板和待决提示行加一句「GitHub 同步停在 HH:MM（原因）」（-08）。
- 推送失败：留在 `undelivered`，恢复后补推（-09）；待决提示行显示待推几条。

## 推翻了哪些旧条目

- board-migration.md「Decisions taken 3」、已定 3、已定 4，以及 T10 的写路径和「板上什么也不回写到 GitHub」：都由本文取代（同上一版）。
- 上一版本文的第 2 节（自写导入、`github-sync` profile、`gh.author` label、按 uid 对账）和第 3 节（自写发件箱 label 队列）：改用原生。

## 拆票（lane: sync）

| 子票 | 做什么 | 被挡 |
| --- | --- | --- |
| -06 只读入站 | 第 1、2 节：配置、轮询器、签名载荷交给本机路由、原生 `into` 导入 channel，首次全量，非 GET 一律拒绝 | 无 |
| -07 任务化与前缀语义 | 第 3 节：root 转任务加 key，前缀变 block/unblock，`state` 变 complete/cancel，重开开新任务，middleware 放行，按平台时间排序 | -06 |
| -08 读切换 | 面板、索引、待决提示行、brief、网页对同步仓库改读本地板，删掉旧的 GitHub 读路径和缓存；同步停了要露出来；每日对账补删除 | -07 |
| -09 推送 | 第 4 节的过滤、`render`、补推、认回声，写路径切换；只对 `github-sync.json` 里的公司仓库 | -08 |
| -10 状态外推与分享 | 第 4 节「状态外推」，第 5 节「本地 → GitHub」那一列 | -09 |
| -11 收尾 | 导入 roubao 的 OKR 三张表；删掉插件和面板按 issue-tracker.md 标题的分流（只限有本机配置的仓库）；GLOSSARY 加术语；T8 编排者场景在 roubao 重跑；在 roubao 的 issue 上知会岳不同 | -10 |

上一版的 -01 到 -05 作废。

## 还没实跑的

| 事项 | 风险 | 子票 |
| --- | --- | --- |
| 轮询器用 REST 对象拼出的载荷，原生 adapter 读不读得通 | VN 原型的载荷是手写的 | -06 |
| `botUserId` 填不存在的 ID 时，原生会不会还去查 `viewer` | 会的话就要发 POST，被拒 | -06 |
| 重复送 `edited`、`closed` 会不会多写 reply | `closed` 会写一条「closed by」，所以只在开关变了时送 | -06 |
| middleware 能不能按作者放行 | 拦住的话导入就断了 | -07 |
| 投递失败后怎么补推 | 原生没有重推入口 | -09 |
