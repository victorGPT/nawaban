import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { text as wholeOf } from 'node:stream/consumers'
import type { board, MessageView } from '@vercel/board'
import { closeTaskOfRootHere, keyOf, markerOf, PUSHED_AS } from './github-tasks.ts'
import { githubSyncConfig, recordPush } from './github-sync-status.ts'
import { githubAccountOf } from './github-account.ts'
import { reposReadOnEveryUseSoEditsNeedNoRestart } from './impact.ts'
import { Refused } from './said.ts'

type Person = ReturnType<typeof board>
export type GithubComment = { id: number; body: string }
export type GithubIssue = { number: number; body: string | null }
export const WANTED_STATES = ['completed', 'not_planned', 'open'] as const
export type WantedState = (typeof WANTED_STATES)[number]
export type Poster = {
  login: string
  commentsSince: (repo: string, issue: number, since: string) => Promise<GithubComment[]>
  post: (repo: string, issue: number, body: string) => Promise<GithubComment>
  assign: (repo: string, issue: number, assigned: boolean) => Promise<void>
  setState: (repo: string, issue: number, wanted: WantedState) => Promise<void>
  openedSince: (repo: string, since: string) => Promise<GithubIssue[]>
  open: (repo: string, title: string, body: string) => Promise<GithubIssue>
}

export const PUSHED_KINDS = new Set(['claim', 'release', 'note', 'decision', 'link', 'ask', 'resolve', 'impact'])
const BOOKKEEPING_NOTE = /^\s*(?:triage:|wayfinder:|lane:|dispatch:|派给 hc )/
const TRIED_AT = 'github-push-tried-at'
export const WANTED_STATE = 'github-state-wanted'
export const SHARE_TO = 'github-share'
const SHARE_TRIED_AT = 'github-share-tried-at'
const STATE_SENT = 'github-state-sent'
const SHARED_FROM_AT_THE_END = /<!-- nawaban-share (\S+) -->\s*$/
const STALE_LABEL_READ = 'label_conflict'
const ASSIGNS = { claim: true, release: false } as Record<string, boolean>
const GITHUB_LISTS_A_NEW_COMMENT_WITHIN_MS = 2 * 60_000
const LOOK_BACK_BEFORE_WRITTEN_MS = 5 * 60_000
const THREADS_PAGE = 100
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024
export const PUSH_EVERY_MS = 10_000

const uidOf = (text: string) => {
  const uid = markerOf(text)?.uid
  return typeof uid === 'string' ? uid : null
}

function goesToGithub(m: MessageView) {
  if (m.from !== null || m.deleted || m.labels[PUSHED_AS] || uidOf(m.text) === null) return false
  const marker = markerOf(m.text)!
  return PUSHED_KINDS.has(String(marker.kind)) && !(marker.kind === 'note' && BOOKKEEPING_NOTE.test(String(marker.body ?? '')))
}

const issueOf = (root: MessageView, repo: string) => (root.labels.issue?.startsWith(`${repo}#`) ? Number(root.labels.issue.slice(repo.length + 1)) : null)

async function issueRoots(person: Person, channel: string, repo: string) {
  const roots: { root: MessageView; issue: number }[] = []
  for (let page = await person.threads({ channel, limit: THREADS_PAGE }); ; page = await person.threads({ channel, limit: THREADS_PAGE, before: page.older! })) {
    for (const { message } of page.threads) {
      const issue = issueOf(message, repo)
      if (issue !== null && !message.deleted) roots.push({ root: message, issue })
    }
    if (!page.older) return roots
  }
}

export async function issueRoot(person: Pick<Person, 'threads'>, channel: string, repo: string, issue: number) {
  const { threads } = await person.threads({ channel, label: { issue: `${repo}#${issue}` }, limit: 1 })
  return threads[0]?.message ?? null
}

export async function writtenHereFirst(person: Pick<Person, 'threads' | 'thread'>, channel: string, repo: string, issue: number, text: string) {
  const uid = uidOf(text)
  if (uid === null) return false
  const root = await issueRoot(person, channel, repo, issue)
  if (!root) return false
  return (await person.thread(root.id)).replies.some((r) => r.from === null && uidOf(r.text) === uid)
}

async function rootOrRefusal(person: Pick<Person, 'threads'>, channel: string, repo: string, issue: number) {
  const root = await issueRoot(person, channel, repo, issue)
  if (!root) throw new Refused(`板上还没有 ${repo}#${issue}：等同步把这个 issue 导进来再写`)
  return root
}

const assigneesOf = (root: MessageView) => Object.entries(root.labels).filter(([name]) => name.startsWith('assignee.')).map(([, login]) => login)

async function refuseAClaimOnAnIssueAssignedToSomeoneElse(root: MessageView, repo: string, issue: number, pushAccount: () => Promise<string>) {
  const assignees = assigneesOf(root)
  if (!assignees.length) return
  const mine = (await pushAccount()).toLowerCase()
  const others = assignees.filter((login) => login.toLowerCase() !== mine)
  if (others.length) throw new Refused(`${repo}#${issue} 在 GitHub 上已指派给 ${others.join('、')}：先在 issue 上和他们说好，由他们取消指派再认领`)
}

export async function writeForGithub(person: Person, channel: string, repo: string, issue: number, text: string, pushAccount: () => Promise<string>) {
  if (uidOf(text) === null) throw new Refused('要推到 GitHub 的回复要带 nawaban marker（旧 CLI 的 gh_post 写的那种）')
  const root = await rootOrRefusal(person, channel, repo, issue)
  if (markerOf(text)!.kind === 'claim') await refuseAClaimOnAnIssueAssignedToSomeoneElse(root, repo, issue, pushAccount)
  return person.reply(root.id, text)
}

export async function wantState(person: Person, channel: string, repo: string, issue: number, wanted: WantedState) {
  const root = await rootOrRefusal(person, channel, repo, issue)
  await person.label(root.id, { set: { [WANTED_STATE]: wanted } })
  if (wanted !== 'open') await closeTaskOfRootHere(person, root, wanted)
}

const unsetUnlessChangedSinceRead = (person: Person, id: string, names: string[], read: Record<string, string>) =>
  person.label(id, { unset: names, if: read }).catch((error: { code?: string }) => {
    if (error.code !== STALE_LABEL_READ) throw error
  })

async function pushInOrderStoppingAtTheFirstThatCannotGo(person: Person, repo: string, issue: number, waiting: MessageView[], poster: Poster, now: number, pushed: { count: number }) {
  for (const m of waiting) {
    const triedAt = m.labels[TRIED_AT]
    if (triedAt && now - Date.parse(triedAt) < GITHUB_LISTS_A_NEW_COMMENT_WITHIN_MS) return
    const uid = uidOf(m.text)!
    const since = new Date(Date.parse(m.createdAt) - LOOK_BACK_BEFORE_WRITTEN_MS).toISOString()
    let copy = triedAt ? (await poster.commentsSince(repo, issue, since)).find((c) => uidOf(c.body) === uid) : undefined
    if (!copy) {
      await person.label(m.id, { set: { [TRIED_AT]: new Date(now).toISOString() } })
      copy = await poster.post(repo, issue, m.text)
    }
    const assigned = ASSIGNS[String(markerOf(m.text)!.kind)]
    if (assigned !== undefined) await poster.assign(repo, issue, assigned)
    await person.label(m.id, { set: { [PUSHED_AS]: String(copy.id) } })
    pushed.count++
  }
}

async function pushWantedState(person: Person, root: MessageView, repo: string, issue: number, poster: Poster) {
  const wanted = root.labels[WANTED_STATE] as WantedState | undefined
  if (!wanted) return
  const target = wanted === 'open' ? 'open' : 'closed'
  const lastSentElseAsPolled = root.labels[STATE_SENT] ?? root.labels.state
  const alreadyThereSoTheFirstToArriveStands = root.labels.state === target && lastSentElseAsPolled === target
  if (!alreadyThereSoTheFirstToArriveStands) {
    await poster.setState(repo, issue, wanted)
    await person.label(root.id, { set: { [STATE_SENT]: target } })
  }
  await unsetUnlessChangedSinceRead(person, root.id, [WANTED_STATE], { [WANTED_STATE]: wanted })
}

const SHARED_FROM = (id: string) => `<!-- nawaban-share ${id} -->`

async function shareAsAnIssue(person: Person, root: MessageView, repo: string, poster: Poster, now: number) {
  const triedAt = root.labels[SHARE_TRIED_AT]
  if (triedAt && now - Date.parse(triedAt) < GITHUB_LISTS_A_NEW_COMMENT_WITHIN_MS) return false
  const since = triedAt && new Date(Date.parse(triedAt) - LOOK_BACK_BEFORE_WRITTEN_MS).toISOString()
  let issue = since ? (await poster.openedSince(repo, since)).find((i) => i.body?.includes(SHARED_FROM(root.id))) : undefined
  if (!issue) {
    await person.label(root.id, { set: { [SHARE_TRIED_AT]: new Date(now).toISOString() } })
    const [title, ...rest] = root.text.split('\n')
    issue = await poster.open(repo, title!, `${rest.join('\n').trim()}\n\n${SHARED_FROM(root.id)}`.trimStart())
  }
  await attachShared(person, root, repo, issue.number)
  return true
}

async function childrenOf(person: Person, key: string) {
  const children: MessageView[] = []
  for (let after: string | undefined; ; ) {
    const page = await person.tasks.list({ state: 'all', label: { parent: key }, after, limit: THREADS_PAGE })
    children.push(...page.tasks.map((t) => t.message))
    if (page.tasks.length < THREADS_PAGE) return children
    after = page.cursor
  }
}

async function attachShared(person: Pick<Person, 'sync' | 'label' | 'tasks'>, root: MessageView, repo: string, issue: number) {
  await person.sync(root.id, `github:${repo}:issue:${issue}`)
  const key = keyOf(root.channel, issue)
  const was = root.labels.key
  await person.label(root.id, { set: { issue: `${repo}#${issue}`, key }, unset: [SHARE_TO, SHARE_TRIED_AT] })
  if (was && was !== key) for (const child of await childrenOf(person as Person, was)) await person.label(child.id, { set: { parent: key } })
}

export async function attachIfSharedFromHere(person: Pick<Person, 'sync' | 'label' | 'tasks' | 'thread'>, repo: string, issue: { number?: number; body?: string | null } | undefined) {
  const id = issue?.number && SHARED_FROM_AT_THE_END.exec(issue.body ?? '')?.[1]
  if (!id) return
  const root = await person.thread(id, { limit: 1 }).then((t) => t.message, () => null)
  if (root && !root.deleted && root.labels[SHARE_TO] === repo && !root.labels.issue) await attachShared(person, root, repo, issue.number!)
}

async function sharesWaiting(person: Person, channel: string, repo: string) {
  return (await person.threads({ channel, label: { [SHARE_TO]: repo }, limit: THREADS_PAGE })).threads.map((t) => t.message).filter((m) => !m.deleted && !m.labels.issue)
}

export async function pushRepo(person: Person, channel: string, repo: string, poster: Poster, now = Date.now()) {
  let unpushed = 0
  const failures: string[] = []
  for (const { root, issue } of await issueRoots(person, channel, repo)) {
    const waiting = (await person.thread(root.id)).replies.filter(goesToGithub).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    const pushed = { count: 0 }
    let stateLeft = root.labels[WANTED_STATE] ? 1 : 0
    try {
      await pushInOrderStoppingAtTheFirstThatCannotGo(person, repo, issue, waiting, poster, now, pushed)
      if (pushed.count === waiting.length) {
        await pushWantedState(person, root, repo, issue, poster)
        stateLeft = 0
      }
    } catch (error) {
      failures.push(`#${issue}：${(error as Error).message}`)
    }
    unpushed += waiting.length - pushed.count + stateLeft
  }
  for (const root of await sharesWaiting(person, channel, repo)) {
    try {
      if (!(await shareAsAnIssue(person, root, repo, poster, now))) unpushed++
    } catch (error) {
      failures.push(`分享 ${root.labels.key ?? root.id}：${(error as Error).message}`)
      unpushed++
    }
  }
  return { unpushed, ...(failures.length ? { error: failures.join('；') } : {}) }
}

const gh = (args: string[], token: string) =>
  new Promise<string>((done, fail) =>
    execFile('gh', args, { env: { ...process.env, GH_TOKEN: token }, maxBuffer: OUTPUT_MAX_BYTES }, (error, stdout, stderr) =>
      error ? fail(new Error(`gh ${args.slice(0, 4).join(' ')}: ${stderr.trim() || error.message}`)) : done(stdout),
    ),
  )

export function ghPoster(token: string, login: string): Poster {
  return {
    login,
    commentsSince: async (repo, issue, since) =>
      (JSON.parse(await gh(['api', '--method', 'GET', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments?since=${since}&per_page=100`], token)) as GithubComment[][]).flat(),
    post: async (repo, issue, body) => JSON.parse(await gh(['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`], token)) as GithubComment,
    assign: async (repo, issue, assigned) => void (await gh(['api', '--method', assigned ? 'POST' : 'DELETE', `repos/${repo}/issues/${issue}/assignees`, '-f', `assignees[]=${login}`], token)),
    setState: async (repo, issue, wanted) =>
      void (await gh(['api', '--method', 'PATCH', `repos/${repo}/issues/${issue}`, '-f', `state=${wanted === 'open' ? 'open' : 'closed'}`, ...(wanted === 'open' ? [] : ['-f', `state_reason=${wanted}`])], token)),
    openedSince: async (repo, since) =>
      (JSON.parse(await gh(['api', '--method', 'GET', '--paginate', '--slurp', `repos/${repo}/issues?state=all&creator=${login}&since=${since}&per_page=100`], token)) as GithubIssue[][]).flat(),
    open: async (repo, title, body) => JSON.parse(await gh(['api', '--method', 'POST', `repos/${repo}/issues`, '-f', `title=${title}`, '-f', `body=${body}`], token)) as GithubIssue,
  }
}

export function pushForever(person: Person, dir: string, pushed: Record<string, string>, posterFor: (channel: string) => Promise<Poster>, log: (line: string) => void) {
  const round = async () => {
    for (const [repo, channel] of Object.entries(pushed)) {
      try {
        await recordPush(dir, repo, await pushRepo(person, channel, repo, await posterFor(channel)))
      } catch (error) {
        log(`${new Date().toISOString()} ${repo} 这一轮没推：${(error as Error).message}`)
        await recordPush(dir, repo, { unpushed: -1, error: (error as Error).message }).catch(() => {})
      }
    }
    setTimeout(round, PUSH_EVERY_MS)
  }
  void round()
}

async function pushedChannelOrRefusal(dir: string, repo: string) {
  const config = await githubSyncConfig(dir)
  const channel = config?.repos[repo]
  if (!channel || !config?.push?.includes(repo)) throw new Refused(`${repo} 没在本机 github-sync.json 的 push 里：照旧直写 GitHub`)
  return channel
}

export async function pushAccountOf(dir: string, channel: string) {
  const checkout = (await reposReadOnEveryUseSoEditsNeedNoRestart(dir))[channel]
  if (!checkout) throw new Refused(`${join(dir, 'repos.json')} 里没有 ${channel} 的本地路径，不知道用哪个 GitHub 账号推`)
  return { checkout, account: await githubAccountOf(checkout) }
}

async function saidAsAHook(write: () => Promise<string>): Promise<number> {
  try {
    process.stdout.write(`✓ ${await write()}\n`)
    return 0
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    process.stderr.write(`✗ ${error.message}\n`)
    return 1
  }
}

export const githubReplyHook = ([repo, issue, ...extra]: string[], person: Person, dir: string) =>
  saidAsAHook(async () => {
    if (!repo || !/^\d+$/.test(issue ?? '') || extra.length) throw new Refused('用法：nawaban hook github-reply <owner/repo> <issue 号>，正文从标准输入读')
    const channel = await pushedChannelOrRefusal(dir, repo)
    const written = await writeForGithub(person, channel, repo, Number(issue), await wholeOf(process.stdin), async () => (await pushAccountOf(dir, channel)).account)
    return `记在板上（${repo}#${issue}，消息 ${written.id}），联网时推到 GitHub`
  })

export const githubStateHook = ([repo, issue, wanted, ...extra]: string[], person: Person, dir: string) =>
  saidAsAHook(async () => {
    if (!repo || !/^\d+$/.test(issue ?? '') || !WANTED_STATES.includes(wanted as WantedState) || extra.length) {
      throw new Refused(`用法：nawaban hook github-state <owner/repo> <issue 号> ${WANTED_STATES.join('|')}`)
    }
    await wantState(person, await pushedChannelOrRefusal(dir, repo), repo, Number(issue), wanted as WantedState)
    return `记在板上（${repo}#${issue} → ${wanted}），联网时推到 GitHub`
  })

export async function share([ref, ...extra]: string[], person: Person, dir: string): Promise<number> {
  return saidAsAHook(async () => {
    if (!ref || extra.length) throw new Refused('用法：nawaban share <票>')
    const keyed = (await person.tasks.list({ state: 'all', label: { key: ref } })).tasks[0]?.message
    const task = keyed ?? (await person.thread(ref, { limit: 1 }).then((t) => t.message, () => null))
    if (!task?.task) throw new Refused(`没有票 ${ref}`)
    const config = await githubSyncConfig(dir)
    const repo = (config?.push ?? []).find((r) => config!.repos[r] === task.channel)
    if (!repo) throw new Refused(`${task.channel} 没有仓库在本机 github-sync.json 的 push 里：分享不出去`)
    const already = task.labels.issue ?? task.labels['issue-root']
    if (already) return `${ref} 已经在 GitHub 上（${task.labels.issue ?? '重开的票，跟着原 issue'}），不再开`
    await person.label(task.id, { set: { [SHARE_TO]: repo } })
    return `记在板上：联网时在 ${repo} 开 issue，把这张票的线程挂上去，之后票号变成 ${task.channel.toUpperCase()}-<issue 号>`
  })
}
