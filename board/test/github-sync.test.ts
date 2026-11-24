import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { deliverAsSignedWebhook, githubSyncConfig, importOnlySync, pollRepo, refusingGithubWrites, type Reader } from '../src/github-sync.ts'
import { verifier } from '../src/server.ts'

const REPO = 'acme/roubao'
const SECRET = 'webhook-secret'
const url = 'http://127.0.0.1:4999/api/board'
const yue = { id: 42, login: 'yuebutong', type: 'User' }
const owner = { id: 1, login: 'wuxianzhong-gpt', type: 'User' }
const repository = { id: 7, name: 'roubao', full_name: REPO, owner: { login: 'acme', id: 9 }, html_url: `https://github.com/${REPO}` }

const issue = (number: number, state: 'open' | 'closed', updated_at: string, extra: Record<string, unknown> = {}) => ({
  id: 5000 + number, number, title: `issue ${number}`, body: 'x', state, user: yue, labels: [], assignees: [],
  html_url: `https://github.com/${REPO}/issues/${number}`, created_at: '2026-11-24T00:00:00Z', updated_at, ...extra,
})
const comment = (id: number, number: number, user: typeof yue, body: string, at: string) => ({
  id, body, user, created_at: at, updated_at: at,
  html_url: `https://github.com/${REPO}/issues/${number}#issuecomment-${id}`, issue_url: `https://api.github.com/repos/${REPO}/issues/${number}`,
})

function readerOf(world: { issues: Record<string, unknown>[]; comments: Record<string, unknown>[] }): Reader & { asked: string[] } {
  const asked: string[] = []
  const numberIn = (path: string) => Number(/issues\/(\d+)/.exec(path)![1])
  return {
    asked,
    list: async (path) => {
      asked.push(path)
      if (/issues\/\d+\/comments/.test(path)) return world.comments.filter((c) => (c.issue_url as string).endsWith(`/${numberIn(path)}`))
      if (path.includes('/issues/comments')) return world.comments
      if (path.includes('state=closed')) return world.issues.filter((i) => i.state === 'closed')
      if (path.includes('state=open')) return world.issues.filter((i) => i.state === 'open')
      return world.issues
    },
    one: async (path) => {
      asked.push(path)
      if (/issues\/\d+$/.test(path)) return { ...world.issues.find((i) => i.number === numberIn(path)), closed_by: owner }
      return repository
    },
  }
}

let team: ReturnType<typeof board>
let dir: string
let githubCalls: { method: string; url: string }[]
const realFetch = globalThis.fetch

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'github-sync-'))
  githubCalls = []
  globalThis.fetch = refusingGithubWrites(async (input, init) => {
    const request = new Request(input, init)
    githubCalls.push({ method: request.method, url: request.url })
    return new Response('{}', { status: 404 })
  })
  const sync = { github: importOnlySync({ repos: { [REPO]: 'roubao' }, reader: owner.login }, 'ghp_test', SECRET) }
  team = board({ backend: local({ memory: true }), authenticate: verifier('board-secret', 'victor'), url, sync })
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const deliver = () => deliverAsSignedWebhook((request) => team.fetch(request), url, SECRET)
const settled = () => new Promise((done) => setTimeout(done, 300))

async function roots() {
  const { messages } = await team.channel('roubao').messages()
  return messages.filter((m) => m.labels.issue)
}

async function repliesOf(issueLabel: string) {
  const root = (await roots()).find((m) => m.labels.issue === issueLabel)!
  return (await team.thread(root.id)).replies
}

describe('只读入站', () => {
  const world = () => ({
    issues: [issue(1730, 'open', '2026-11-24T10:00:00Z'), issue(1700, 'closed', '2026-11-24T09:00:00Z'), issue(1729, 'open', '2026-11-24T11:00:00Z', { pull_request: {} })],
    comments: [
      comment(9001, 1730, yue, '待决：@wuxianzhong-gpt 片源接入走哪条？', '2026-11-24T10:01:00Z'),
      comment(9002, 1730, owner, '进展：已完成：接好片源', '2026-11-24T10:02:00Z'),
    ],
  })

  it('把开着的和刚关的 issue 及其评论导入 channel，跳过 PR，决策者账号写的评论也导入', async () => {
    await pollRepo(REPO, dir, readerOf(world()), deliver())
    await settled()
    const byIssue = Object.fromEntries((await roots()).map((m) => [m.labels.issue, m.labels.state]))
    expect(byIssue).toEqual({ [`${REPO}#1730`]: 'open', [`${REPO}#1700`]: 'closed' })
    const replies = await repliesOf(`${REPO}#1730`)
    expect(replies.map((r) => [r.text, r.by.actor])).toEqual([
      ['待决：@wuxianzhong-gpt 片源接入走哪条？', 'github:user:42'],
      ['进展：已完成：接好片源', 'github:user:1'],
    ])
  })

  it('再轮询一次什么也不新增', async () => {
    const w = world()
    await pollRepo(REPO, dir, readerOf(w), deliver())
    await settled()
    const before = (await team.channel('roubao').messages()).messages.length
    const again = readerOf(w)
    await pollRepo(REPO, dir, again, deliver())
    await settled()
    expect(again.asked.some((p) => p.includes('since=2026-11-24T10:58:00.000Z'))).toBe(true)
    expect((await team.channel('roubao').messages()).messages.length).toBe(before)
  })

  it('issue 在 GitHub 上关了，下一轮 root 变成 state=closed', async () => {
    const w = world()
    await pollRepo(REPO, dir, readerOf(w), deliver())
    w.issues[0] = issue(1730, 'closed', '2026-11-24T12:00:00Z')
    await pollRepo(REPO, dir, readerOf(w), deliver())
    await settled()
    expect((await roots()).find((m) => m.labels.issue === `${REPO}#1730`)!.labels.state).toBe('closed')
    expect((await repliesOf(`${REPO}#1730`)).at(-1)!.text).toBe('closed by wuxianzhong-gpt')
  })

  it('整个过程不往 GitHub 发任何写请求', async () => {
    const w = world()
    w.comments.push(comment(9003, 1650, yue, '没导入过的旧 issue 上的新评论', '2026-11-24T10:05:00Z'))
    w.issues.push(issue(1650, 'open', '2026-11-24T10:05:00Z'))
    await pollRepo(REPO, dir, readerOf(w), deliver())
    await settled()
    expect(githubCalls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('一条载荷没交成，游标不动，下一轮从原处重拉', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('board down'))
    const reader = readerOf(world())
    await expect(pollRepo(REPO, dir, reader, failing)).rejects.toThrow('board down')
    const next = readerOf(world())
    await pollRepo(REPO, dir, next, deliver())
    expect(next.asked).toContain(`repos/${REPO}/issues?state=open&per_page=100`)
  })
})

describe('写保护', () => {
  it('拒绝发往 api.github.com 的非 GET 请求，放过读和别的主机', async () => {
    const through = vi.fn(async () => new Response('ok'))
    const guarded = refusingGithubWrites(through)
    await expect(guarded('https://api.github.com/repos/acme/roubao/issues/1/comments', { method: 'POST', body: '{}' })).rejects.toThrow('不往 GitHub 写')
    await expect(guarded('https://api.github.com/graphql', { method: 'POST', body: '{}' })).rejects.toThrow('不往 GitHub 写')
    await guarded('https://api.github.com/repos/acme/roubao/issues/1')
    await guarded('http://127.0.0.1:4999/api/board/webhooks/github', { method: 'POST', body: '{}' })
    expect(through).toHaveBeenCalledTimes(2)
  })
})

describe('配置', () => {
  it('没有 github-sync.json 就不同步', async () => {
    expect(await githubSyncConfig(dir)).toBeNull()
  })

  it('格式不对就说清楚该怎么写', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 1 } }))
    await expect(githubSyncConfig(dir)).rejects.toThrow('"reader"')
  })
})
