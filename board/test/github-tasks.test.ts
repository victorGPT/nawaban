import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { board, type MessageView } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { deliverAsSignedWebhook, importOnlySync, pollRepo, type Reader } from '../src/github-sync.ts'
import { HELD_FOR_A_GITHUB_ASK, settleIssueTasks } from '../src/github-tasks.ts'
import { verifier } from '../src/server.ts'

const REPO = 'acme/roubao'
const SECRET = 'webhook-secret'
const url = 'http://127.0.0.1:4999/api/board'
const yue = { id: 42, login: 'yuebutong', type: 'User' }
const owner = { id: 1, login: 'wuxianzhong-gpt', type: 'User' }
const repository = { id: 7, name: 'roubao', full_name: REPO, owner: { login: 'acme', id: 9 }, html_url: `https://github.com/${REPO}` }

type Issue = Record<string, unknown> & { number: number; state: string; updated_at: string }
const issue = (number: number, state: 'open' | 'closed', updated_at: string, extra: Record<string, unknown> = {}): Issue => ({
  id: 5000 + number, number, title: `issue ${number}`, body: 'x', state, state_reason: state === 'closed' ? 'completed' : null, user: yue, labels: [], assignees: [],
  html_url: `https://github.com/${REPO}/issues/${number}`, created_at: '2026-11-24T00:00:00Z', updated_at, ...extra,
})
let commentId = 9000
const comment = (number: number, body: string, at: string, user = yue) => ({
  id: ++commentId, body, user, created_at: at, updated_at: at,
  html_url: `https://github.com/${REPO}/issues/${number}#issuecomment-${commentId}`, issue_url: `https://api.github.com/repos/${REPO}/issues/${number}`,
})

type World = { issues: Issue[]; comments: ReturnType<typeof comment>[] }
const readerOf = (world: World): Reader => ({
  list: async (path) => {
    const n = /issues\/(\d+)\/comments/.exec(path)?.[1]
    if (n) return world.comments.filter((c) => c.issue_url.endsWith(`/${n}`))
    if (path.includes('/issues/comments')) return world.comments
    if (path.includes('state=closed')) return world.issues.filter((i) => i.state === 'closed')
    if (path.includes('state=open')) return world.issues.filter((i) => i.state === 'open')
    return world.issues
  },
  one: async (path) => {
    const n = /issues\/(\d+)$/.exec(path)?.[1]
    return n ? { ...world.issues.find((i) => i.number === Number(n)), closed_by: owner } : repository
  },
  now: async () => '2026-11-24T12:00:00.000Z',
})

let team: ReturnType<typeof board>
let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'github-tasks-'))
  const sync = { github: importOnlySync({ repos: { [REPO]: 'roubao' }, reader: owner.login }, 'ghp_test', SECRET) }
  team = board({ backend: local({ memory: true }), authenticate: verifier('board-secret', 'victor'), url, sync })
})

const importDrains = () => new Promise((done) => setTimeout(done, 300))
async function poll(world: World) {
  const settle = (known: Parameters<typeof settleIssueTasks>[3]) => settleIssueTasks(team, 'roubao', REPO, known)
  await pollRepo(REPO, dir, readerOf(world), deliverAsSignedWebhook((r) => team.fetch(r), url, SECRET))
  await importDrains()
  await pollRepo(REPO, dir, { ...readerOf(world), list: async (p) => (p.includes('since=') ? [] : readerOf(world).list(p)) }, deliverAsSignedWebhook((r) => team.fetch(r), url, SECRET), Date.now(), settle)
}

async function tasksKeyed(key: string): Promise<MessageView[]> {
  return (await team.tasks.list({ channel: 'roubao', state: 'all', label: { key } })).tasks.map((t) => t.message)
}
async function theTask(key: string) {
  const all = await tasksKeyed(key)
  expect(all).toHaveLength(1)
  return all[0]!
}

describe('导入的 issue 变成任务', () => {
  it('开着的 issue 是 ready 的任务，key 是 ROUBAO-<号>', async () => {
    await poll({ issues: [issue(1730, 'open', '2026-11-24T10:00:00Z')], comments: [] })
    const t = await theTask('ROUBAO-1730')
    expect(t.labels.issue).toBe(`${REPO}#1730`)
    expect(t.task?.state).toBe('ready')
  })

  it('再结算一遍不会多出任务', async () => {
    const world = { issues: [issue(1730, 'open', '2026-11-24T10:00:00Z')], comments: [] }
    await poll(world)
    await poll(world)
    await theTask('ROUBAO-1730')
  })

  it('关掉的 issue：completed 的任务 completed，not planned 的 canceled', async () => {
    await poll({ issues: [issue(1700, 'closed', '2026-11-24T09:00:00Z'), issue(1701, 'closed', '2026-11-24T09:00:00Z', { state_reason: 'not_planned' })], comments: [] })
    expect((await theTask('ROUBAO-1700')).task?.state).toBe('completed')
    expect((await theTask('ROUBAO-1701')).task?.state).toBe('canceled')
  })
})

describe('前缀变成任务状态', () => {
  it('同事的「待决：」让任务挂成 awaiting_approval，「已决：」解除', async () => {
    const world: World = { issues: [issue(1728, 'open', '2026-11-24T10:00:00Z')], comments: [comment(1728, '待决：@wuxianzhong-gpt 直达 X 上不上？', '2026-11-24T10:01:00Z')] }
    await poll(world)
    const held = (await theTask('ROUBAO-1728')).task
    expect(held?.state).toBe('blocked')
    expect(held?.blocked).toEqual({ kind: 'awaiting_approval', reason: `${HELD_FOR_A_GITHUB_ASK}@wuxianzhong-gpt 直达 X 上不上？` })
    world.comments.push(comment(1728, '已决：B，先不上', '2026-11-24T10:05:00Z', owner))
    await poll(world)
    expect((await theTask('ROUBAO-1728')).task?.state).toBe('ready')
  })

  it('带粗体和署名的手写前缀也认', async () => {
    await poll({ issues: [issue(1729, 'open', '2026-11-24T10:00:00Z')], comments: [comment(1729, '**待决**（岳不同）：要不要上', '2026-11-24T10:01:00Z')] })
    expect((await theTask('ROUBAO-1729')).task?.blocked?.kind).toBe('awaiting_approval')
  })

  it('本地自己挂的等待不被 GitHub 这边解除', async () => {
    const world: World = { issues: [issue(1731, 'open', '2026-11-24T10:00:00Z')], comments: [] }
    await poll(world)
    const t = await theTask('ROUBAO-1731')
    await team.tasks.block(t.id, '等你：本地的问题', { kind: 'needs_input' })
    await poll(world)
    expect((await theTask('ROUBAO-1731')).task?.blocked?.reason).toBe('等你：本地的问题')
  })
})

describe('结算出错', () => {
  it('一个 issue 结算失败，别的照常结算，游标照常前进', async () => {
    const world: World = { issues: [issue(1740, 'open', '2026-11-24T10:00:00Z'), issue(1741, 'open', '2026-11-24T10:00:00Z')], comments: [] }
    await pollRepo(REPO, dir, readerOf(world), deliverAsSignedWebhook((r) => team.fetch(r), url, SECRET))
    await importDrains()
    const failingFor1740 = { ...team, threads: (async (q: Parameters<typeof team.threads>[0]) => ((q as { label?: Record<string, string> }).label?.issue?.endsWith('#1740') ? Promise.reject(new Error('坏了')) : team.threads(q))) as typeof team.threads }
    const settle = (known: Parameters<typeof settleIssueTasks>[3]) => settleIssueTasks(failingFor1740 as typeof team, 'roubao', REPO, known)
    const asked: string[] = []
    const reader = { ...readerOf(world), now: async () => '2026-11-24T13:00:00.000Z', list: async (p: string) => (asked.push(p), p.includes('since=') ? [] : readerOf(world).list(p)) }
    await expect(pollRepo(REPO, dir, reader, deliverAsSignedWebhook((r) => team.fetch(r), url, SECRET), Date.now(), settle)).rejects.toThrow('#1740：坏了')
    expect((await theTask('ROUBAO-1741')).task?.state).toBe('ready')
    await pollRepo(REPO, dir, reader, deliverAsSignedWebhook((r) => team.fetch(r), url, SECRET))
    expect(asked.filter((p) => p.includes('since=2026-11-24T12:58:00.000Z'))).not.toHaveLength(0)
  })
})

describe('关票和重开', () => {
  it('任务被别人认领时 issue 关了，交还以后下一轮完成', async () => {
    const world: World = { issues: [issue(1732, 'open', '2026-11-24T10:00:00Z')], comments: [] }
    await poll(world)
    const claim = await team.as('worker').tasks.claim((await theTask('ROUBAO-1732')).id)
    world.issues[0] = issue(1732, 'closed', '2026-11-24T11:00:00Z')
    await poll(world)
    expect((await theTask('ROUBAO-1732')).task?.state).toBe('claimed')
    await claim.release()
    await poll(world)
    expect((await theTask('ROUBAO-1732')).task?.state).toBe('completed')
  })

  it('关了又重开：新开一个任务接过 key，旧任务留着历史', async () => {
    const world: World = { issues: [issue(1733, 'closed', '2026-11-24T09:00:00Z')], comments: [] }
    await poll(world)
    const finished = await theTask('ROUBAO-1733')
    world.issues[0] = issue(1733, 'open', '2026-11-24T11:00:00Z')
    await poll(world)
    const reopened = await theTask('ROUBAO-1733')
    expect(reopened.id).not.toBe(finished.id)
    expect(reopened.task?.state).toBe('ready')
    expect(reopened.labels).toMatchObject({ 'reopened-from': finished.id, 'issue-root': finished.id })
    await poll(world)
    expect((await theTask('ROUBAO-1733')).id).toBe(reopened.id)
  })
})
