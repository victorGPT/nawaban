import { execFile } from 'node:child_process'
import { text as wholeOf } from 'node:stream/consumers'
import type { board, MessageView } from '@vercel/board'
import { markerOf, PUSHED_AS } from './github-tasks.ts'
import { githubSyncConfig, recordPush } from './github-sync-status.ts'
import { Refused } from './said.ts'

type Person = ReturnType<typeof board>
export type GithubComment = { id: number; body: string }
export type Poster = {
  commentsSince: (repo: string, issue: number, since: string) => Promise<GithubComment[]>
  post: (repo: string, issue: number, body: string) => Promise<GithubComment>
}

export const PUSHED_KINDS = new Set(['claim', 'release', 'note', 'decision', 'link', 'ask', 'resolve', 'impact'])
const BOOKKEEPING_NOTE = /^\s*(?:triage:|wayfinder:|lane:|dispatch:|派给 hc )/
const TRIED_AT = 'github-push-tried-at'
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

export async function writeForGithub(person: Person, channel: string, repo: string, issue: number, text: string) {
  if (uidOf(text) === null) throw new Refused('要推到 GitHub 的回复要带 nawaban marker（旧 CLI 的 gh_post 写的那种）')
  const root = await issueRoot(person, channel, repo, issue)
  if (!root) throw new Refused(`板上还没有 ${repo}#${issue}：等同步把这个 issue 导进来再写`)
  return person.reply(root.id, text)
}

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
    await person.label(m.id, { set: { [PUSHED_AS]: String(copy.id) } })
    pushed.count++
  }
}

export async function pushRepo(person: Person, channel: string, repo: string, poster: Poster, now = Date.now()) {
  let unpushed = 0
  const failures: string[] = []
  for (const { root, issue } of await issueRoots(person, channel, repo)) {
    const waiting = (await person.thread(root.id)).replies.filter(goesToGithub).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    const pushed = { count: 0 }
    try {
      await pushInOrderStoppingAtTheFirstThatCannotGo(person, repo, issue, waiting, poster, now, pushed)
    } catch (error) {
      failures.push(`#${issue}：${(error as Error).message}`)
    }
    unpushed += waiting.length - pushed.count
  }
  return { unpushed, ...(failures.length ? { error: failures.join('；') } : {}) }
}

const gh = (args: string[], token: string) =>
  new Promise<string>((done, fail) =>
    execFile('gh', args, { env: { ...process.env, GH_TOKEN: token }, maxBuffer: OUTPUT_MAX_BYTES }, (error, stdout, stderr) =>
      error ? fail(new Error(`gh ${args.slice(0, 4).join(' ')}: ${stderr.trim() || error.message}`)) : done(stdout),
    ),
  )

export function ghPoster(token: string): Poster {
  return {
    commentsSince: async (repo, issue, since) =>
      (JSON.parse(await gh(['api', '--method', 'GET', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments?since=${since}&per_page=100`], token)) as GithubComment[][]).flat(),
    post: async (repo, issue, body) => JSON.parse(await gh(['api', '--method', 'POST', `repos/${repo}/issues/${issue}/comments`, '-f', `body=${body}`], token)) as GithubComment,
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

export async function githubReplyHook([repo, issue, ...extra]: string[], person: Person, dir: string): Promise<number> {
  try {
    if (!repo || !/^\d+$/.test(issue ?? '') || extra.length) throw new Refused('用法：nawaban hook github-reply <owner/repo> <issue 号>，正文从标准输入读')
    const config = await githubSyncConfig(dir)
    const channel = config?.repos[repo]
    if (!channel || !config?.push?.includes(repo)) throw new Refused(`${repo} 没在本机 github-sync.json 的 push 里：照旧直写 GitHub`)
    const written = await writeForGithub(person, channel, repo, Number(issue), await wholeOf(process.stdin))
    process.stdout.write(`✓ 记在板上（${repo}#${issue}，消息 ${written.id}），联网时推到 GitHub\n`)
    return 0
  } catch (error) {
    if (!(error instanceof Refused)) throw error
    process.stderr.write(`✗ ${error.message}\n`)
    return 1
  }
}
