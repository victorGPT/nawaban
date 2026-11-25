import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { board, type MessageView } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { deliverAsSignedWebhook, importOnlySync, pollRepo, recordRound, syncStalledNote, type Reader } from '../src/github-sync.ts'
import { recordPush } from '../src/github-sync-status.ts'
import { pushRepo, writeForGithub, type GithubComment, type Poster } from '../src/github-push.ts'
import { HELD_FOR_A_GITHUB_ASK, settleIssueTasks } from '../src/github-tasks.ts'
import { webAnswerText } from '../src/page.ts'
import { registerSchemas } from '../src/schemas.ts'
import { verifier } from '../src/server.ts'
import { boardData } from '../src/views.ts'

const REPO = 'acme/roubao'
const SECRET = 'webhook-secret'
const url = 'http://127.0.0.1:4999/api/board'
const yue = { id: 42, login: 'yuebutong', type: 'User' }
const owner = { id: 1, login: 'wuxianzhong-gpt', type: 'User' }
const repository = { id: 7, name: 'roubao', full_name: REPO, owner: { login: 'acme', id: 9 }, html_url: `https://github.com/${REPO}` }
const WORD: Record<string, string> = { note: '进展', ask: '待决', resolve: '已决', decision: '决定', link: 'PR', claim: '认领' }

let uids = 0
const asTheOldCliWritesIt = (kind: string, body: string) =>
  `${WORD[kind]}：${body}\n\n<!-- nawaban ${JSON.stringify({ v: 1, uid: `u-${++uids}`, kind, author: 'selftest', at: 1, body }).replaceAll('-', '\\u002d')} -->`

type Comment = GithubComment & { user: typeof yue; created_at: string; updated_at: string; issue_url: string; html_url: string }
type World = { open: number[]; comments: Comment[]; down: boolean; postedButNoAnswer: boolean; posts: number }
let nextComment = 9000
const commentOn = (issue: number, body: string, user = yue): Comment => {
  const at = new Date(Date.parse('2026-11-25T10:00:00Z') + nextComment * 1000).toISOString()
  return { id: ++nextComment, body, user, created_at: at, updated_at: at, issue_url: `https://api.github.com/repos/${REPO}/issues/${issue}`, html_url: '' }
}
const issueOf = (n: number) => ({ id: 5000 + n, number: n, title: `issue ${n}`, body: 'x', state: 'open', state_reason: null, user: yue, labels: [], assignees: [], html_url: `https://github.com/${REPO}/issues/${n}`, created_at: '2026-11-24T00:00:00Z', updated_at: '2026-11-24T00:00:00Z' })

const readerOf = (w: World): Reader => ({
  list: async (path) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    const n = /issues\/(\d+)\/comments/.exec(path)?.[1]
    if (n) return w.comments.filter((c) => c.issue_url.endsWith(`/${n}`))
    if (path.includes('/issues/comments')) return w.comments
    return w.open.map(issueOf)
  },
  one: async (path) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    const n = /issues\/(\d+)$/.exec(path)?.[1]
    return n ? issueOf(Number(n)) : repository
  },
  now: async () => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    return '2026-11-25T12:00:00.000Z'
  },
})

const posterOf = (w: World): Poster => ({
  commentsSince: async (_repo, issue) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    return w.comments.filter((c) => c.issue_url.endsWith(`/${issue}`))
  },
  post: async (_repo, issue, body) => {
    if (w.down) throw new Error('getaddrinfo ENOTFOUND api.github.com')
    w.posts++
    const c = commentOn(issue, body, owner)
    w.comments.push(c)
    if (w.postedButNoAnswer) throw new Error('502 Bad Gateway')
    return c
  },
})

let team: ReturnType<typeof board>
let dir: string
let world: World

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'github-push-'))
  const sync = { github: importOnlySync({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }, 'ghp_test', SECRET) }
  team = board({ backend: local({ memory: true }), authenticate: verifier('board-secret', 'victor'), url, sync })
  world = { open: [1730], comments: [], down: false, postedButNoAnswer: false, posts: 0 }
  await poll()
})

const importDrains = () => new Promise((done) => setTimeout(done, 300))
async function poll() {
  const settle = (known: Parameters<typeof settleIssueTasks>[3]) => settleIssueTasks(team, 'roubao', REPO, known)
  await pollRepo(REPO, dir, readerOf(world), deliverAsSignedWebhook((r) => team.fetch(r), url, SECRET), Date.now(), settle).catch(() => {})
  await importDrains()
}
const push = (now = Date.now()) => pushRepo(team, 'roubao', REPO, posterOf(world), now)
const write = (kind: string, body: string) => writeForGithub(team, 'roubao', REPO, 1730, asTheOldCliWritesIt(kind, body))
const replies = async (): Promise<MessageView[]> => {
  const root = (await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1730` } })).threads[0]!.message
  return (await team.thread(root.id)).replies.filter((r) => !r.deleted)
}
const theTask = async () => (await team.tasks.list({ channel: 'roubao', state: 'all', label: { key: 'ROUBAO-1730' } })).tasks[0]!.message
const onGithub = () => world.comments.map((c) => c.body)

describe('先写板，联网后推到 GitHub', () => {
  it('断网时写进展立刻记在板上、面板看得到；联网后 GitHub 上只多一条，原文一字不差，拉回来也不多', async () => {
    world.down = true
    const written = await write('note', '离线写的进展')
    const row = (await boardData(team, 'roubao')).columns.flatMap((c) => c.tasks as { id: string; progress: { body: string } | null }[]).find((t) => t.id === 'ROUBAO-1730')!
    expect(row.progress?.body).toBe('离线写的进展')
    expect(await push()).toMatchObject({ unpushed: 1, error: expect.stringContaining('ENOTFOUND') })
    world.down = false
    const afterGithubWouldHaveListedAnythingSentBeforeItWentDown = Date.now() + 3 * 60_000
    expect(await push(afterGithubWouldHaveListedAnythingSentBeforeItWentDown)).toEqual({ unpushed: 0 })
    expect(onGithub()).toEqual([written.text])
    await poll()
    await poll()
    expect(await push(afterGithubWouldHaveListedAnythingSentBeforeItWentDown)).toEqual({ unpushed: 0 })
    expect(onGithub()).toHaveLength(1)
    expect((await replies()).map((r) => r.text)).toEqual([written.text])
  })

  it('不该推的不推：triage、wayfinder、lane 记账，网页答复，不带 marker 的板上回复', async () => {
    await registerSchemas(team)
    await write('note', 'triage: needs-info')
    await write('note', 'lane: sync')
    await write('note', 'wayfinder: 下一步看 -10')
    const root = (await team.threads({ channel: 'roubao', label: { issue: `${REPO}#1730` } })).threads[0]!.message
    await team.reply(root.id, webAnswerText({ option: 'A', words: '网页上答的' }))
    await team.reply(root.id, '板上随手记的')
    await write('decision', '用方案 B')
    expect(await push()).toEqual({ unpushed: 0 })
    expect(onGithub()).toEqual([expect.stringMatching(/^决定：用方案 B/)])
  })

  it('GitHub 收下了但响应丢了：两分钟内不重推，之后按 uid 认出来，不再 POST；serve 重启也一样（记在板上的 label 里）', async () => {
    world.postedButNoAnswer = true
    await write('note', '响应丢了的那条')
    const t0 = Date.now()
    expect((await push(t0)).unpushed).toBe(1)
    world.postedButNoAnswer = false
    expect((await push(t0 + 60_000)).unpushed).toBe(1)
    expect(world.posts).toBe(1)
    expect(await push(t0 + 3 * 60_000)).toEqual({ unpushed: 0 })
    expect(world.posts).toBe(1)
    expect(onGithub()).toHaveLength(1)
  })

  it('同一个 issue 按写的先后推，前一条推不出去，后一条也等着', async () => {
    world.postedButNoAnswer = true
    await write('ask', '上线吗')
    await write('resolve', '上')
    await push()
    expect(world.posts).toBe(1)
    expect(onGithub()).toEqual([expect.stringMatching(/^待决：上线吗/)])
  })
})

describe('推不出去要看得见', () => {
  it('待决提示行和面板写明还有几条没推、为什么', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    await recordRound(dir, REPO)
    await recordPush(dir, REPO, { unpushed: 2, error: '#1730：getaddrinfo ENOTFOUND api.github.com' })
    expect(await syncStalledNote(dir, 'roubao')).toBe('有 2 条还没推到 GitHub（#1730：getaddrinfo ENOTFOUND api.github.com）')
    await recordPush(dir, REPO, { unpushed: 0 })
    expect(await syncStalledNote(dir, 'roubao')).toBeNull()
  })
})

describe('板上写的待决和已决，和 GitHub 来的一起算', () => {
  it('断网时本地写待决，任务挂起；本地记已决，挂起解除，不会被下一轮挂回去', async () => {
    world.down = true
    await write('ask', '上线吗')
    await poll()
    expect((await theTask()).task?.blocked?.reason).toBe(`${HELD_FOR_A_GITHUB_ASK}上线吗`)
    await write('resolve', '上')
    await poll()
    expect((await theTask()).task?.blocked).toBeFalsy()
    world.down = false
    await push(Date.now() + 3 * 60_000)
    await poll()
    await poll()
    expect((await theTask()).task?.blocked).toBeFalsy()
  })

  it('本地待决推出去之后，同事在 GitHub 上记已决，挂起解除', async () => {
    await write('ask', '上线吗')
    await push()
    await poll()
    expect((await theTask()).task?.blocked).toBeTruthy()
    world.comments.push(commentOn(1730, '已决：上'))
    await poll()
    await poll()
    expect((await theTask()).task?.blocked).toBeFalsy()
  })
})
