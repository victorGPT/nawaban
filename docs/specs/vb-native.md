# Vercel Board 原生 GitHub 同步和任务动词：能替掉我们自写的哪些

> NAWABAN-VB-NATIVE，2026-11-25。只调研，不改产品代码。依据：`@vercel/board` 0.53.0 的 docs 和 dist（下文 `docs/…`、`dist/…` 都指 `board/node_modules/@vercel/board/` 下的文件），`@chat-adapter/github` 4.45.0，本仓库 `board/src/`。每条标「实跑」（附命令或输出）、「读源码/文档」（附行号）或「推断」。
> 判定按决策者 11-25 的口径，三选一：**原生**（直接用原生）、**加一层**（原生不够，在它上面加，写明加什么）、**自建**（只能自建，附原生做不到的证据）。

## 结论

1. **本地板能用 sync-github，不要 Vercel 账号，也不要 Vercel Connect。** `nawaban serve` 自己调 `board({ backend: local({ dir }) … })`（`board/src/server.ts:437`），在这里加 `sync: { github: github({ adapter: createGitHubAdapter({ token, webhookSecret }) }, repos(…)) }` 就行。实跑通过：用 PAT 加 webhook secret，导入、重投去重、签名校验、自定义格式外推都正常（见附录）。
2. **原生同步只有 webhook，没有轮询，也没有补拉。** GitHub 必须能 POST 到 `/api/board/webhooks/github`，可我们的板只听 `127.0.0.1`（`board/src/server.ts:111`）。所以 MIGRATE-10 的「拉取器」不能整个删：缩成一个**本机轮询器**，把 REST 读到的 issue 和评论拼成 webhook 载荷、签好名，POST 给本机的 webhook 路由。导入、去重、作者、状态 label 全交给原生。这样数据不出本机，断网补拉也有了。
3. **发件箱换成原生 deliver 加一个 sync 函数。** 函数里过滤「只推同事需要的」，用 `render` 写出和旧 `gh_post` 一字不差的「前缀 + marker」。原生不做的有三件，都得自建或加一层：外推开关票和 assignee、无限重试、开 issue。
4. **有一条硬约束：推送账号自己写的评论不会被导入**（实跑）。凡是用这个账号绕过板直接写 GitHub 的路径（旧 CLI 降级直写、网页记已决调 `cli.py`），写下的东西都回不到板上。推送要换专用 bot 账号或 GitHub App，或者把这些路径改成先写板。
5. **任务动词我们大多已经包在原生外面，没有重造。** 真正重造或撞名的只有两处：`nawaban block`（就是原生 `tasks needs`，而且和原生 `tasks block` 同名不同义），以及 `pulls.ts` 用 `gh pr view` 轮询 PR 状态（开了 PR 同步之后，原生 label 就有这个状态）。

## 1. 本地板上能不能用

| 问题 | 答案 | 证据 |
| --- | --- | --- |
| sync 在 `local()` 上跑吗 | 跑。sync 在 `board()` 里运行，Vercel 板、`local()`、自定义后端都一样 | 读文档 `docs/02-sync/01-overview.md:27` |
| `vb serve` 呢 | 没有 sync。不影响我们，`nawaban serve` 不是 `vb serve` | 读文档 `docs/04-reference/01-cli.md:487`，`dist/serve-Ci5KT11x.mjs:78` |
| 能在 CLI 那一侧配吗 | 不能。设了 `BOARD_URL` 的 `board()` 带 `sync` 会抛错，只能配在 `nawaban serve` 进程里 | 读文档 `docs/02-sync/01-overview.md:30-32` |
| 依赖 | peer 依赖没装，今天 import 就失败。要装 `chat`、`@chat-adapter/github`；`dist/sync-github.mjs:5` 静态 import 了 `@vercel/connect/chat`，所以 `@vercel/connect` 这个包也得装，但不用开账号 | 实跑：`cd ~/.nawaban/plugin/board && node -e "import('@vercel/board/sync-github')"` 输出 `ERR_MODULE_NOT_FOUND Cannot find package 'chat'` |
| 要 Vercel 账号或 Connect 吗 | 不要。adapter 支持 PAT（`token`）加 `webhookSecret`，也支持 GitHub App | 读源码 `@chat-adapter/github/dist/index.d.ts:94`（PAT）、`docs/02-sync/04-github.md:197`（Without Connect）；实跑 PAT 模式，见附录 |
| 数据出不出本机 | 往外只有 deliver 调 `api.github.com`，本来就要写 GitHub。不用 Connect 就不经过 Vercel。入站有两种走法：一是给 GitHub 一个公网入口（`tailscale funnel` 只开 `/api/board/webhooks/github` 这一条路径，或者 smee 一类经第三方转发）；二是本机轮询器自己喂，不开公网入口，推荐这个 | 读文档 `docs/02-sync/04-github.md:193`（webhook 地址）；`board/src/server.ts:111` 只听 127.0.0.1 |
| 有没有轮询或补拉 | 没有。`sync-github.mjs` 只在评论落到没见过的 issue 上时调一次 `issues.get` 建 root（`dist/sync-github.mjs:508-512`，`docs/02-sync/04-github.md:159`）。文档里说的「pull」是板拉自己的收件箱，不是拉 GitHub（`dist/engine-506f7GEM.mjs:58-59` `PULL_MS`） | 读源码 |
| 离线时漏掉的 webhook | GitHub 不会自动重投失败的投递，只能手动或调 API 重投 | 读 GitHub 文档 https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks （没实跑） |
| 仓库权限 | 当前 gh 账号对 roubao 是 admin，可以建仓库 webhook | 实跑：`gh api repos/Business-Center-AI-Efficiency/roubao --jq .permissions` 输出 `{"admin":true,…}` |

## 2. 对照 local-first-github-sync.md 逐条

| 规格条目 | 判定 | 加什么，或者证据 |
| --- | --- | --- |
| §1 映射：issue 对应线程，root 带 `issue=owner/repo#N` | **原生** | 实跑：导入的 root 带 `issue=acme/roubao#1730`、`state=open` |
| §1 映射：root 还是任务，带 `key=ROUBAO-N` | **加一层** | sync 函数里调 `import('roubao', { labels: { key } })`（`docs/02-sync/02-functions.md` Overrides 一节），再调 `tasks.create({ re: root })` 转成任务。实跑：转成后 `board.task=ready` |
| §1 重开开新线程 | **加一层** | 原生的 `issue.reopened` 只改 `state` label（`docs/02-sync/04-github.md` Events 表）；任务 completed 以后不能 reopen。监听 `state` 从 closed 变回 open，新建一个任务，带上 `reopened-from` |
| §2 增量拉取、游标、60 秒 | **加一层** | 原生只收 webhook（见上）。加一个本机轮询器：用规格里那两条 `since` 查询，把结果拼成 `issues` 和 `issue_comment` 的 webhook 载荷，HMAC 签名后 POST 到本机 `/api/board/webhooks/github`。规格 §2 自写的去重、作者、label 全部删掉 |
| §2 幂等 | **原生** | 实跑：同一条评论用两个不同的 delivery id 各投一次，板上只有 1 条 reply。去重按评论 ID，不按投递 ID，所以轮询器重叠拉取是安全的 |
| §2 同事评论的作者 | **原生**，比规格的做法好 | 实跑：reply 的作者是 `github:user:42`，不需要 `github-sync` profile，也不需要 `gh.author` label。`local()` 上的导入按平台用户署名（`docs/02-sync/01-overview.md:137`） |
| §2 带前缀或 marker 的评论按语义记成事件 | **加一层** | 原生只存原文。导入的写入会过 middleware（`02-functions.md`「More than an import」），在 middleware 或读的一侧按旧 `GH_WORDS` 和前缀规则解析 |
| §2 本地发出、推送后又拉回来的评论按 uid 对上 | **原生**，这一节可以删 | 板不导入自己发的评论（`docs/02-sync/01-overview.md:129`）。实跑：推送账号（`botUserId`）写的评论没有导入 |
| §2 编辑和删除 | **原生**（收到 webhook 时）加**加一层**（离线期间） | Events 表里写着「Edits and deletes sync too」。离线期间漏掉的删除，靠轮询器的每日全量对账补 |
| §2 middleware 放过导入 | **加一层** | 导入走 middleware；`impactNames`（`board/src/server.ts:437`）和决策卡校验要按作者前缀 `github:` 放行。没实跑 |
| §3 只推同事需要的 | **加一层** | sync 函数：`if (sync.direction === 'out' && 要推(sync.message)) await sync.deliver(...)`，按消息的 schema 或前缀判断 |
| §3 格式和旧 `gh_post` 一字不差 | **原生**（`render`） | 实跑：POST 的 body 是 `进展：已完成：接好片源\n\n<!-- nawaban {"uid":"u1"} -->` |
| §3 发件箱、按 issue 先进先出 | **原生** | 投递走线程 lane，按顺序（`docs/02-sync/01-overview.md` 中「retried, on the thread's lane」那一段） |
| §3 重试：断网时一直重试，不丢 | **加一层** | 原生重试 5 次后记 `message.sync_failed`，失败原因留在消息的 `undelivered` 里（`docs/02-sync/01-overview.md:271`，`dist/engine-506f7GEM.mjs:57,1161-1170`）；重试靠进程里的定时器，重启就丢（`docs/01-board/10-local.md:31-32`）。CLI 没有重推的入口（`01-cli.md` 里找不到 redeliver 或 resend）。要加：恢复后扫 `undelivered` 不为空的消息补推。具体怎么补推没实跑，是最大的未知数 |
| §3 推送账号 | **加一层**（配置） | 用专用账号或 GitHub App 的凭据。不能用决策者自己的账号，理由见「结论」第 4 条 |
| §4 关票、重开、assignee 推到 GitHub | **自建** | 原生不外推：label 不往外同步（`docs/02-sync/01-overview.md:128`），任务状态不跟同步副本（`docs/01-board/11-tasks.md:366`）。在 sync 函数或 tail 里拿到 adapter 的 octokit，调 `issues.update` 和 `addAssignees` |
| §4 GitHub 关票、assignee 同步回本地 | **原生** 加 **加一层** | 原生会维护 `state`、`assignee.*`、`tag.*`（`docs/02-sync/04-github.md:155`）。要加：`state=closed` 时 complete 或 cancel 任务；本地 claim 前看 `assignee.*` |
| §4 待决、已决前缀改挂起状态 | **加一层** | 同「带前缀的评论」那一行，解析出来后调 `tasks block` 或 `tasks unblock` |
| §1 和 -04 share：本地新建的票开 GitHub issue | **自建** | GitHub 不能由 root 开 issue（`docs/02-sync/01-overview.md:108`，`docs/02-sync/04-github.md:95`）。自己调 `issues.create`，再 `vb sync <id> github:owner/repo:issue:N` 把线程挂上去 |
| §5 首次全量导入 | **加一层** | 轮询器先跑一遍全量，内容同上。原生只在有新事件时补建 root（`docs/02-sync/04-github.md:159`） |
| §6 断网时把同步状态露出来 | **加一层** | 原生有 `undelivered`、`message.sync_failed`、`vb inbox github`、`vb sync <id>`；待决提示行读这些就行，不用另建 `nawaban sync status` |
| §7 旧 CLI 降级直写、网页记已决 | **加一层**，有前提 | 只有当这些写入不是推送账号写的，才会被导入（实跑：推送账号的评论没导入）。网页记已决（`board/src/server.ts:341` 调 `cli.py`）要改成先写板 |

## 3. 原生任务动词：我们有没有重造

| 原生 | 我们的 | 判定 | 给 CLI-SIMPLE 的建议 |
| --- | --- | --- | --- |
| `tasks claim --ready --wait`（`docs/01-board/11-tasks.md:64`） | 派单由编排者推给指定终端，替 worker 认领：`board/src/dispatch.ts:269` 调原生 `tasks claim --as` | **加一层** | 保留 `dispatch`。它选终端、开 worker 进程，这是原生没有的；认领本身已经是原生 |
| 租约、`tasks renew`（`11-tasks.md:67`） | `LEASE='1h'`（`board/src/tasks.ts:11`），钩子 `renew` 逐个调原生 renew（`tasks.ts:283`） | **加一层** | 保留。原生 `tasks run` 自动续租，但前提是活儿是一条命令（`11-tasks.md:172`）；agent 会话不是一条命令 |
| `tasks release` | `claim --release` 调原生，另外一次清掉 `terminal`、`progress`、`progress.at` 三个 label（`tasks.ts:207`） | **原生**，薄包装 | 保持现状 |
| `tasks fail` / `reopen` | 不用。`close` 只有 done 和 cancelled | **原生** | 误关的票没法 reopen，只有 failed 能（`11-tasks.md` States 表）。可以考虑「可能重做」的票用 fail 关；不加新动词 |
| `tasks block`（挂起，hold） | `event ask` 调原生 `tasks block --kind awaiting_approval`（`board/src/events.ts:93`），加了决策卡校验 | **加一层** | 保留。0.53.0 没有叫 `hold` 的动词，挂起就是 `tasks block` |
| `tasks needs`（`01-cli.md:1086`） | `nawaban block <票> <挡它的票>` 就是包了一层 `tasks.needs`（`board/src/tasks.ts:111`） | **原生**，我们的是重造，还撞名 | 删掉 `nawaban block`，用 `nawaban board tasks needs`。CLI-SIMPLE 草案把它留在 `help more`，建议改掉。`create --blocked-by` 保留 |
| 作废的前置票不会让后续票变成可开工（`11-tasks.md:196`，原生故意这样设计） | `close --cancelled` 把作废的票从后续票的 needs 里摘掉（`tasks.ts:213`） | **加一层** | 保留 |
| `--as`、`BOARD_PROFILE`（`11-tasks.md:40,134`） | 从会话环境变量推出 profile 名（`tasks.ts:31`），再传 `--as` | **加一层** | 保留。命名规则是我们的，传递用原生 |
| `schedule`（`01-cli.md:1041`） | 没有自建，7 天里用了 0 次 | **原生** | 什么都不做 |
| `wait --mentions`、`wait --re`（`01-cli.md:1397,1444`） | `page`、`inbox` 是钩子读的提示文本（`board/src/orchestrator.ts:209,232`），不是阻塞等待 | 两样东西，不算重造 | worker 等答复时用原生 `nawaban board wait --re <id>`，可以写进 skill；钩子的提示行保留 |
| watchers、`tail` | 服务器的 SSE 用原生 `team.events`（`server.ts:180`）；`pulls.ts:27-31` 用 `gh pr view` 轮询 PR 的状态和 CI | SSE 是**原生**；PR 状态是**重造** | 开了 PR 同步（`repos({ … pulls })`）以后，PR 的 root 自带 `state=merged`、`ci.*`、`review` label（`04-github.md` State labels），`pulls.ts` 显示 PR 状态可以换成读 label。`merge` 等 CI 不能换：同步来的 label 分不清某个 head 上的 CI 是过了、还在跑还是被取消（NAWABAN-NATIVE-AUDIT 实测），`merge` 保留自己的 `gh` 检查。这一步排在 webhook 入口之后，轮询器也要覆盖 PR |

## 给编排者的建议

- MIGRATE-10 改成：「`nawaban serve` 挂原生 `sync-github`」，加三层：本机轮询器喂 webhook；sync 函数（过滤，`render` 出前缀和 marker）；状态外推加前缀解析。规格 §2 的导入、去重、作者，§3 的队列和格式，都删掉。
- 要定的事：推送用哪个账号（专用账号还是 GitHub App）；入站走本机轮询器还是公网入口。我推荐本机轮询器，数据不出本机，断网补拉也一起有了。

## 还没实跑的

| 事项 | 风险 |
| --- | --- |
| 投递失败后怎么补推 | 原生没有重推入口，可能要另发一条 reply |
| 轮询器拼出来的载荷字段够不够 | 原型里的载荷是手写的；真实的 `issue_comment` 载荷字段更多，adapter 可能读到原型没给的字段 |
| middleware 放行导入 | `impactNames` 会不会拦住导入的消息 |
| GitHub API 全部打桩 | 原型没有连真 GitHub |

## 附录：原型

环境：`@vercel/board@0.53.0`、`chat`、`@chat-adapter/github@4.45.0`、`@vercel/connect` 装在临时目录。用 `local({ dir })` 加和 `nawaban serve` 同样语义的 `authenticate`，没带 `middleware`。GitHub API 用 fetch 打桩，webhook 载荷是自己拼的。命令：`PDIR=<临时目录>/bdir node proto-dir.mjs`。在 `local({ memory: true })` 上跑出来的结果一样。

```js
import { createHmac } from 'node:crypto'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { github, repos } from '@vercel/board/sync-github'
import { createGitHubAdapter } from '@chat-adapter/github'

const sent = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.includes('api.github.com')) {
    const method = init?.method ?? (input.method || 'GET')
    let body = init?.body ?? null
    sent.push({ method, url, body: typeof body === 'string' ? body : null })
    if (url.includes('/comments') && method === 'POST') return new Response(JSON.stringify({ id: 999001, body: JSON.parse(body).body, user: { id: 1, login: 'wuxianzhong-gpt' }, created_at: new Date().toISOString(), html_url: 'https://github.com/acme/roubao/issues/1730#issuecomment-999001' }), { status: 201, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return realFetch(input, init)
}

const SECRET = 's3cret'
const team = board({
  backend: local({ dir: process.env.PDIR }),
  authenticate: (request) => (request.credential == null ? null : Response.json({ error: { code: 'unauthorized' } }, { status: 401 })),
  url: 'http://127.0.0.1:4999/api/board',
  sync: {
    github: github(
      { adapter: createGitHubAdapter({ token: 'ghp_fake', webhookSecret: SECRET, botUserId: 1, userName: 'wuxianzhong-gpt' }), botUserId: 1 },
      repos({ 'acme/roubao': { issues: async (sync) => {
        if (sync.direction === 'in') return void (await sync.import('roubao'))
        if (sync.message.from === null) await sync.deliver({ render: ({ message }) => '进展：' + message.text + '\n\n<!-- nawaban {"uid":"u1"} -->' })
      } } }),
    ),
  },
})

const repo = { id: 7, name: 'roubao', full_name: 'acme/roubao', owner: { login: 'acme', id: 9 }, html_url: 'https://github.com/acme/roubao' }
const user = { login: 'yuebutong', id: 42, type: 'User', avatar_url: '' }
const issue = { id: 5001, number: 1730, title: '播放页广告', body: 'x', state: 'open', user, labels: [], assignees: [], html_url: 'https://github.com/acme/roubao/issues/1730', created_at: '2026-11-24T00:00:00Z', updated_at: '2026-11-24T00:00:00Z' }
async function hook(event, delivery, payload) {
  const body = JSON.stringify(payload)
  const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex')
  const res = await team.fetch(new Request('http://127.0.0.1:4999/api/board/webhooks/github', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': sig } }))
  return res.status + ' ' + (await res.text()).slice(0, 120)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = {}
out.opened = await hook('issues', 'd1', { action: 'opened', issue, repository: repo, sender: user })
const comment = { id: 7133625379, body: '待决：@wuxianzhong-gpt 片源接入走哪条？', user, created_at: '2026-11-24T01:00:00Z', updated_at: '2026-11-24T01:00:00Z', html_url: issue.html_url + '#issuecomment-7133625379', issue_url: 'https://api.github.com/repos/acme/roubao/issues/1730' }
out.comment = await hook('issue_comment', 'd2', { action: 'created', issue, comment, repository: repo, sender: user })
out.commentAgain = await hook('issue_comment', 'd2-other-delivery', { action: 'created', issue, comment, repository: repo, sender: user })
out.selfComment = await hook('issue_comment', 'd3', { action: 'created', issue, comment: { ...comment, id: 7133680059, body: '岳不同：手写的，不带前缀', user: { login: 'wuxianzhong-gpt', id: 1, type: 'User' } }, repository: repo, sender: { login: 'wuxianzhong-gpt', id: 1, type: 'User' } })
out.badSig = (await team.fetch(new Request('http://127.0.0.1:4999/api/board/webhooks/github', { method: 'POST', body: '{}', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': 'sha256=00' } }))).status
await sleep(1500)
const read = await team.channel('roubao').messages()
out.roots = read.messages.map((m) => ({ id: m.id, text: m.text, labels: m.labels, by: m.by?.actor, task: !!m.task }))
const rootId = read.messages[0]?.id
if (rootId) {
  const th = await team.thread(rootId)
  out.replies = th.replies.map((r) => ({ text: r.text, by: r.by?.actor, from: r.from }))
  try { const t = await team.tasks.create({ re: rootId }); out.taskOfImported = JSON.stringify(t).slice(0,300) } catch (e) { out.taskOfImported = 'ERR ' + e.stack.split('\n').slice(0,3).join(' | ') }
  await team.reply(rootId, '已完成：接好片源')
  await sleep(2500)
  out.sync = await team.sync(rootId).catch((e) => 'ERR ' + e.message)
}
out.githubCalls = sent.map((s) => ({ method: s.method, url: s.url.replace('https://api.github.com', ''), body: s.body && s.body.slice(0, 200) }))
console.log(JSON.stringify(out, null, 1))
process.exit(0)
```

输出：

```json
{
 "opened": "200 ok",
 "comment": "200 ok",
 "commentAgain": "200 ok",
 "selfComment": "200 ok",
 "badSig": 401,
 "roots": [
  {
   "id": "2",
   "text": "Issue #1730: 播放页广告\nhttps://github.com/acme/roubao/issues/1730",
   "labels": {
    "issue": "acme/roubao#1730",
    "state": "open"
   },
   "by": "github:user:42",
   "task": false
  },
  {
   "id": "3",
   "text": "待决：@wuxianzhong-gpt 片源接入走哪条？",
   "labels": {},
   "by": "github:user:42",
   "task": false
  }
 ],
 "replies": [
  {
   "text": "待决：@wuxianzhong-gpt 片源接入走哪条？",
   "by": "github:user:42",
   "from": "github"
  }
 ],
 "taskOfImported": "{\"task\":{\"id\":\"2\",\"channel\":\"roubao\",\"text\":\"Issue #1730: 播放页广告\\nhttps://github.com/acme/roubao/issues/1730\",\"re\":null,\"replyTo\":null,\"thread\":\"e28ad083-33c7-85d8-9b7f-856ff227a5fb\",\"labels\":{\"issue\":\"acme/roubao#1730\",\"state\":\"open\",\"board.task\":\"ready\"},\"reactions\":{},\"by\":{\"actor\":\"github:user:42",
 "sync": {
  "targets": [
   {
    "target": "github:acme/roubao:issue:1730",
    "key": "github",
    "thread": "github:acme/roubao:issue:1730",
    "message": "lifecycle:d7e02b1e-cdef-8068-ab1e-2bb2b1c00998",
    "url": "https://github.com/acme/roubao/issues/1730",
    "undelivered": null
   }
  ]
 },
 "githubCalls": [
  {
   "method": "POST",
   "url": "/repos/acme/roubao/issues/1730/comments",
   "body": "{\"body\":\"进展：已完成：接好片源\\n\\n<!-- nawaban {\\\"uid\\\":\\\"u1\\\"} -->\"}"
  }
 ]
}
```

读法：`opened`、`comment` 返回 200，板上建了 root 和 reply。`commentAgain` 换了 delivery id 重投，没有多出 reply。`selfComment` 是推送账号（id 1）写的评论，没有导入。`badSig` 返回 401。`taskOfImported` 显示导入的 root 转成了任务。`githubCalls` 是在板上回复之后外推的那一条，body 是 render 出来的格式。`roots` 里的第 3 条就是那条 reply，`messages()` 把 reply 也列进来了。
