import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createGitHubAdapter } from '@chat-adapter/github'
import { into } from '@vercel/board/sync'
import { github, repos } from '@vercel/board/sync-github'
import type { KnownIssue } from './github-tasks.ts'

const CONFIG_FILE = 'github-sync.json'
const STATE_FOLDER = 'github-sync'
const WEBHOOK_SECRET_FILE = 'github-webhook-secret'
const SECRET_BYTES = 32
const OUTPUT_MAX_BYTES = 256 * 1024 * 1024
export const POLL_EVERY_MS = 60_000
const OVERLAP_FOR_GITHUB_WRITE_LAG_MS = 2 * 60_000
const RECENTLY_CLOSED_MS = 2 * 24 * 60 * 60_000
export const NO_GITHUB_USER_HAS_THIS_ID = Number.MAX_SAFE_INTEGER
const GITHUB_API_HOST = 'api.github.com'
const READ_METHODS = new Set(['GET', 'HEAD'])
const GITHUB_DATE_HEADER = /^date:\s*(.+?)\r?$/im

export type SyncConfig = { repos: Record<string, string>; reader: string }
type User = { id: number; login: string }
type Issue = { number: number; title: string; state: 'open' | 'closed'; state_reason?: string | null; updated_at: string; user: User; closed_by?: User | null; pull_request?: unknown }
type Comment = { id: number; issue_url: string; created_at: string; updated_at: string; user: User }
type Seen = { state: Issue['state']; title: string; state_reason?: string | null; reopens?: number }
type RepoState = { since?: string; issues: Record<string, Seen> }
export type Reader = { list: (path: string) => Promise<unknown[]>; one: (path: string) => Promise<unknown>; now: () => Promise<string> }
export type Deliver = (event: 'issues' | 'issue_comment', payload: Record<string, unknown>) => Promise<void>

export async function githubSyncConfig(dir: string): Promise<SyncConfig | null> {
  let text
  try {
    text = await readFile(join(dir, CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const config = JSON.parse(text) as Partial<SyncConfig>
  const reposValid = typeof config.repos === 'object' && config.repos !== null && Object.values(config.repos).every((c) => typeof c === 'string')
  if (!reposValid || typeof config.reader !== 'string') throw new Error(`${join(dir, CONFIG_FILE)} 要写成 { "repos": { "<owner>/<repo>": "<channel>" }, "reader": "<gh 账号>" }`)
  return config as SyncConfig
}

export async function webhookSecret(dir: string): Promise<string> {
  const path = join(dir, WEBHOOK_SECRET_FILE)
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await writeFile(path, randomBytes(SECRET_BYTES).toString('hex'), { flag: 'wx', mode: 0o600 }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  return (await readFile(path, 'utf8')).trim()
}

export function refusingGithubWrites(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (new URL(url).host === GITHUB_API_HOST && !READ_METHODS.has(method)) {
      return Promise.reject(new Error(`推送身份未定，不往 GitHub 写：拒绝了 ${method} ${url}`))
    }
    return fetch(input, init)
  }
}

export function importOnlySync(config: SyncConfig, token: string, secret: string) {
  const adapter = createGitHubAdapter({ token, webhookSecret: secret, botUserId: NO_GITHUB_USER_HAS_THIS_ID, userName: 'nawaban-sync' })
  const routes = Object.fromEntries(Object.entries(config.repos).map(([repo, channel]) => [repo, { issues: into(channel) }]))
  return github({ adapter, botUserId: NO_GITHUB_USER_HAS_THIS_ID }, repos(routes))
}

const ghOutput = (args: string[], token?: string) =>
  new Promise<string>((done, fail) =>
    execFile('gh', args, { env: token ? { ...process.env, GH_TOKEN: token } : process.env, maxBuffer: OUTPUT_MAX_BYTES }, (error, stdout, stderr) =>
      error ? fail(new Error(`gh ${args.join(' ')}: ${stderr.trim() || error.message}`)) : done(stdout),
    ),
  )

export const readerToken = async (login: string) => (await ghOutput(['auth', 'token', '--user', login])).trim()

export function ghReader(token: string): Reader {
  return {
    list: async (path) => (JSON.parse(await ghOutput(['api', '--method', 'GET', '--paginate', '--slurp', path], token)) as unknown[][]).flat(),
    one: async (path) => JSON.parse(await ghOutput(['api', '--method', 'GET', path], token)),
    now: async () => new Date(GITHUB_DATE_HEADER.exec(await ghOutput(['api', '--include', '--method', 'GET', 'rate_limit'], token))![1]!).toISOString(),
  }
}

export function deliverAsSignedWebhook(fetch: (request: Request) => Promise<Response>, boardUrl: string, secret: string): Deliver {
  return async (event, payload) => {
    const body = JSON.stringify(payload)
    const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
    const headers = { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': signature }
    const response = await fetch(new Request(`${boardUrl}/webhooks/github`, { method: 'POST', body, headers }))
    if (!response.ok) throw new Error(`${event} ${String(payload.action)} 交给本机路由失败：${response.status} ${await response.text()}`)
  }
}

const stateFile = (dir: string, repo: string) => join(dir, STATE_FOLDER, `${encodeURIComponent(repo)}.json`)

async function loadState(path: string): Promise<RepoState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RepoState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { issues: {} }
    throw error
  }
}

async function saveState(path: string, state: RepoState) {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(state))
  await rename(tmp, path)
}

const backedOff = (iso: string) => new Date(Date.parse(iso) - OVERLAP_FOR_GITHUB_WRITE_LAG_MS).toISOString()
const byUpdated = <T extends { updated_at: string }>(a: T, b: T) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0)
const numberOf = (comment: Comment) => Number(comment.issue_url.slice(comment.issue_url.lastIndexOf('/') + 1))

function actionsBringingTheBoardTo(issue: Issue, seen: Seen | undefined): { action: string; changes?: unknown }[] {
  if (!seen) return [{ action: 'opened' }, ...(issue.state === 'closed' ? [{ action: 'closed' }] : [])]
  const retitled = seen.title !== issue.title ? [{ action: 'edited', changes: { title: { from: seen.title } } }] : []
  const moved = seen.state !== issue.state ? [{ action: issue.state === 'closed' ? 'closed' : 'reopened' }] : [{ action: 'labeled' }]
  return [...retitled, ...moved]
}

export type Settle = (known: KnownIssue[]) => Promise<void>

export async function pollRepo(repo: string, dir: string, reader: Reader, deliver: Deliver, now = Date.now(), settle: Settle = async () => {}) {
  const path = stateFile(dir, repo)
  const state = await loadState(path)
  const roundStartedOnGithubClock = await reader.now()
  const listed = (state.since === undefined
    ? [...(await reader.list(`repos/${repo}/issues?state=open&per_page=100`)), ...(await reader.list(`repos/${repo}/issues?state=closed&since=${new Date(now - RECENTLY_CLOSED_MS).toISOString()}&per_page=100`))]
    : await reader.list(`repos/${repo}/issues?state=all&since=${backedOff(state.since)}&sort=updated&direction=asc&per_page=100`)) as Issue[]
  const issues = new Map(listed.filter((i) => !i.pull_request).sort(byUpdated).map((i) => [i.number, i]))
  const repository = await reader.one(`repos/${repo}`)
  const comments = (state.since === undefined ? [] : await reader.list(`repos/${repo}/issues/comments?since=${backedOff(state.since)}&sort=updated&direction=asc&per_page=100`)) as Comment[]
  const deliverComment = async (issue: Issue, comment: Comment) => {
    await deliver('issue_comment', { action: 'created', issue, comment, repository, sender: comment.user })
    if (comment.updated_at !== comment.created_at) await deliver('issue_comment', { action: 'edited', issue, comment, repository, sender: comment.user, changes: {} })
  }
  const bringIssueUpToDate = async (issue: Issue) => {
    const seen = state.issues[issue.number]
    const actions = actionsBringingTheBoardTo(issue, seen)
    const closer = actions.some((a) => a.action === 'closed') ? ((await reader.one(`repos/${repo}/issues/${issue.number}`)) as Issue).closed_by : null
    for (const { action, changes } of actions) {
      const sender = (action === 'closed' && closer) || issue.user
      await deliver('issues', { action, issue, repository, sender, ...(changes ? { changes } : {}) })
    }
    if (!seen) for (const comment of ((await reader.list(`repos/${repo}/issues/${issue.number}/comments?per_page=100`)) as Comment[]).sort(byUpdated)) await deliverComment(issue, comment)
    const reopens = (seen?.reopens ?? 0) + (actions.some((a) => a.action === 'reopened') ? 1 : 0)
    state.issues[issue.number] = { state: issue.state, title: issue.title, state_reason: issue.state_reason ?? null, reopens }
  }
  try {
    for (const [number, seen] of Object.entries(state.issues)) {
      if (seen.state === 'closed' && seen.state_reason === undefined && !issues.has(Number(number))) seen.state_reason = ((await reader.one(`repos/${repo}/issues/${number}`)) as Issue).state_reason ?? null
    }
    for (const issue of issues.values()) await bringIssueUpToDate(issue)
    for (const comment of [...comments].sort(byUpdated)) {
      const issue = issues.get(numberOf(comment)) ?? ((await reader.one(`repos/${repo}/issues/${numberOf(comment)}`)) as Issue)
      if (issue.pull_request) continue
      if (state.issues[issue.number]) await deliverComment(issue, comment)
      else await bringIssueUpToDate(issue)
    }
    state.since = roundStartedOnGithubClock
  } finally {
    await saveState(path, state)
  }
  await settle(Object.entries(state.issues).map(([number, seen]) => ({ number: Number(number), state_reason: seen.state_reason, reopens: seen.reopens ?? 0 })))
}

export function pollForever(config: SyncConfig, dir: string, reader: () => Promise<Reader>, deliver: Deliver, settleFor: (repo: string, channel: string) => Settle, log: (line: string) => void) {
  const round = async () => {
    try {
      const read = await reader()
      for (const [repo, channel] of Object.entries(config.repos)) await pollRepo(repo, dir, read, deliver, Date.now(), settleFor(repo, channel))
    } catch (error) {
      log(`${new Date().toISOString()} GitHub 同步这一轮没完成，游标没动，下一轮重来：${(error as Error).message}`)
    }
    setTimeout(round, POLL_EVERY_MS)
  }
  void round()
}
