import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { deliverAsSignedWebhook, githubSyncConfig, githubSyncConfigToPoll, importOnlySync, pollRepo, recordRound, refusingGithubWrites, switchOnceEveryOpenIssueHasATask, syncStalledNote, unswitchUntilThisServeChecksAgain, type Reader } from '../src/github-sync.ts'
import { openIssuesWithoutAnOpenTask, settleIssueTasks } from '../src/github-tasks.ts'
import { recordSwitch } from '../src/github-sync-status.ts'
import { githubRepos } from '../src/github.ts'
import { boardData } from '../src/views.ts'
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

function readerOf(world: { issues: Record<string, unknown>[]; comments: Record<string, unknown>[]; now?: string }): Reader & { asked: string[] } {
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
    now: async () => world.now ?? '2026-11-24T12:00:00.000Z',
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
    expect(again.asked.some((p) => p.includes('since=2026-11-24T11:58:00.000Z'))).toBe(true)
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

  function racingWorld(openListing: ReturnType<typeof issue>[]) {
    const old = issue(1, 'open', '2026-11-24T10:00:00Z')
    const createdDuringTheFirstRound = issue(2, 'open', '2026-11-24T10:01:00Z')
    const closedLater = issue(3, 'closed', '2026-11-24T10:05:00Z')
    const history = comment(90, 2, yue, '重开前就有的评论', '2026-11-20T09:00:00Z')
    const reader: Reader = {
      list: async (path) => {
        if (/issues\/2\/comments/.test(path)) return [history]
        if (path.includes('comments')) return []
        if (path.includes('state=open')) return openListing
        if (path.includes('state=closed')) return [closedLater]
        const since = Date.parse(/since=([^&]+)/.exec(path)![1]!)
        return [old, createdDuringTheFirstRound, closedLater].filter((i) => Date.parse(i.updated_at) > since)
      },
      one: async (path) => (path.endsWith('/3') ? { ...closedLater, closed_by: owner } : repository),
      now: async () => '2026-11-24T10:00:30.000Z',
    }
    return { reader, old }
  }

  for (const [why, open] of [['open 列表有东西', true], ['open 列表为空', false]] as const) {
    it(`首次全量时新建或重开的 issue，下一轮补上它和它的历史评论（${why}）`, async () => {
      const { reader, old } = racingWorld([])
      if (open) reader.list = ((list) => async (path: string) => (path.includes('state=open') ? [old] : list(path)))(reader.list)
      await pollRepo(REPO, dir, reader, deliver(), Date.parse('2026-11-24T10:06:00Z'))
      await pollRepo(REPO, dir, reader, deliver())
      await settled()
      expect((await roots()).map((m) => m.labels.issue)).toContain(`${REPO}#2`)
      expect((await repliesOf(`${REPO}#2`)).map((r) => r.text)).toEqual(['重开前就有的评论'])
    })
  }

  it('一条载荷没交成，游标不动，下一轮从原处重拉', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('board down'))
    const reader = readerOf(world())
    await expect(pollRepo(REPO, dir, reader, failing)).rejects.toThrow('board down')
    const next = readerOf(world())
    await pollRepo(REPO, dir, next, deliver())
    expect(next.asked).toContain(`repos/${REPO}/issues?state=open&per_page=100`)
  })
})

describe('多个仓库', () => {
  it('名字拼起来一样的两个仓库各有各的游标，各自做首次全量', async () => {
    const asked: string[] = []
    const reader = (repo: string): Reader => ({
      list: async (path) => (asked.push(`${repo} ${path}`), []),
      one: async () => ({ ...repository, full_name: repo }),
      now: async () => '2026-11-24T12:00:00.000Z',
    })
    for (const repo of ['acme-tools/service', 'acme/tools-service']) await pollRepo(repo, dir, reader(repo), deliver())
    expect(asked.filter((p) => p.includes('state=open'))).toHaveLength(2)
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

  it('放行的请求原样交出去，body 没被读掉', async () => {
    const guarded = refusingGithubWrites(async (input) => new Response(await (input as Request).text()))
    expect(await (await guarded(new Request('http://127.0.0.1:4999/api/board/webhooks/github', { method: 'POST', body: 'payload' }))).text()).toBe('payload')
    await expect(guarded(new Request('https://api.github.com/graphql', { method: 'POST', body: '{}' }))).rejects.toThrow('不往 GitHub 写')
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

describe('全量入站核对完才切到板上', () => {
  it('首轮没跑完、有 open issue 还没变成票，都不切；全都有票才切，serve 重启后要重新核对', async () => {
    await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: owner.login, push: [REPO] }))
    const switched = async () => (await githubSyncConfig(dir))!.repos
    const openWithoutATask = (issues: number[]) => openIssuesWithoutAnOpenTask(team, 'roubao', issues)
    expect(Object.keys((await githubSyncConfigToPoll(dir))!.repos)).toEqual([REPO])
    expect(await switched()).toEqual({})
    expect(await switchOnceEveryOpenIssueHasATask(dir, REPO, openWithoutATask)).toContain('首轮全量还没完成')

    const world = { issues: [issue(1, 'open', '2026-11-24T10:00:00Z'), issue(2, 'open', '2026-11-24T10:01:00Z'), issue(3, 'closed', '2026-11-24T10:02:00Z')], comments: [] }
    await pollRepo(REPO, dir, readerOf(world), deliver(), Date.parse('2026-11-24T12:00:00Z'), async () => {})
    await settled()
    expect(await switchOnceEveryOpenIssueHasATask(dir, REPO, openWithoutATask)).toContain('2/2 个 open issue 板上还没有未完成的票（#1 #2）')
    expect(await githubSyncConfig(dir)).toMatchObject({ repos: {}, push: [] })

    await pollRepo(REPO, dir, readerOf(world), deliver(), Date.parse('2026-11-24T12:00:00Z'), (known) => settleIssueTasks(team, 'roubao', REPO, known))
    expect(await switchOnceEveryOpenIssueHasATask(dir, REPO, openWithoutATask)).toContain('2 个 open issue 板上都有票')
    expect(await githubSyncConfig(dir)).toMatchObject({ repos: { [REPO]: 'roubao' }, push: [REPO] })
    expect(await switchOnceEveryOpenIssueHasATask(dir, REPO, openWithoutATask)).toBeNull()

    await unswitchUntilThisServeChecksAgain(dir, [REPO])
    expect(await switched()).toEqual({})
  })
})

describe('同步停了要露出来', () => {
  const config = { repos: { [REPO]: 'roubao' }, reader: owner.login }
  const now = Date.parse('2026-11-24T12:00:00Z')
  beforeEach(async () => writeFile(join(dir, 'github-sync.json'), JSON.stringify(config)))

  it('配置了但还没跑过一轮，说还没跑过', async () => {
    expect(await syncStalledNote(dir, 'roubao', now)).toContain('还没跑过一轮')
  })

  it('最近一轮成功就不说话；连着失败超过 3 分钟，说停在几点、为什么', async () => {
    await recordRound(dir, REPO, undefined, new Date(now - 60_000))
    expect(await syncStalledNote(dir, 'roubao', now)).toBeNull()
    await recordRound(dir, REPO, new Error('gh: network down'), new Date(now))
    expect(await syncStalledNote(dir, 'roubao', now)).toBeNull()
    const okAt = new Date(now - 60_000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    expect(await syncStalledNote(dir, 'roubao', now + 3 * 60_000)).toBe(`GitHub 同步停在 ${okAt}（gh: network down）`)
  })

  it('不同步的 channel 不说话', async () => {
    expect(await syncStalledNote(dir, 'nawaban', now)).toBeNull()
  })

  it('看板 JSON 带上这句，面板据此显示', async () => {
    expect((await boardData(team, 'roubao', dir)).syncNote).toContain('还没跑过一轮')
    expect((await boardData(team, 'nawaban', dir)).syncNote).toBeUndefined()
  })

  it('切到板上的仓库不再从 GitHub 读，没切的照旧', async () => {
    const repoDir = join(dir, 'roubao-checkout')
    await mkdir(join(repoDir, 'docs/agents'), { recursive: true })
    await writeFile(join(repoDir, 'docs/agents/issue-tracker.md'), '# Issue tracker: GitHub\n')
    await writeFile(join(dir, 'repos.json'), JSON.stringify({ roubao: repoDir, other: repoDir }))
    expect(Object.keys(await githubRepos(dir))).toEqual(['roubao', 'other'])
    await recordSwitch(dir, REPO, { at: '2026-11-24T12:00:00.000Z', openIssues: 0 })
    expect(Object.keys(await githubRepos(dir))).toEqual(['other'])
    expect(Object.keys(await githubRepos(dir, { evenWhenSyncedToTheBoard: true }))).toEqual(['roubao', 'other'])
  })
})

describe('每天对一次删除', () => {
  it('从没记过评论 ID 的旧状态，第一次对账先记下，之后删掉的也能删', async () => {
    const c = comment(9201, 1730, yue, '旧状态里的评论', '2026-11-24T10:01:00Z')
    const w = { issues: [issue(1730, 'open', '2026-11-24T10:00:00Z')], comments: [c], now: '2026-11-24T12:00:00.000Z' }
    await pollRepo(REPO, dir, readerOf(w), deliver())
    const path = join(dir, 'github-sync', `${encodeURIComponent(REPO)}.json`)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    delete saved.comments
    saved.reconciledAt = '2026-11-23T11:00:00.000Z'
    await writeFile(path, JSON.stringify(saved))
    const onlyTheDailyReconcileSeesComments = { ...readerOf(w), list: async (p: string) => (p.includes('/issues/comments') ? [] : readerOf(w).list(p)) }
    await pollRepo(REPO, dir, onlyTheDailyReconcileSeesComments, deliver())
    w.comments = []
    w.now = '2026-11-25T13:00:00.000Z'
    await pollRepo(REPO, dir, readerOf(w), deliver())
    await settled()
    expect((await repliesOf(`${REPO}#1730`)).filter((r) => !r.deleted)).toEqual([])
  })

  it('GitHub 上删掉的评论，过了一天的那一轮在板上也删掉', async () => {
    const kept = comment(9101, 1730, yue, '留着的', '2026-11-24T10:01:00Z')
    const removed = comment(9102, 1730, yue, '会被删的', '2026-11-24T10:02:00Z')
    const w = { issues: [issue(1730, 'open', '2026-11-24T10:00:00Z')], comments: [kept, removed], now: '2026-11-24T12:00:00.000Z' }
    await pollRepo(REPO, dir, readerOf(w), deliver())
    await pollRepo(REPO, dir, readerOf(w), deliver())
    w.comments = [kept]
    w.now = '2026-11-24T13:00:00.000Z'
    await pollRepo(REPO, dir, readerOf(w), deliver())
    await settled()
    expect((await repliesOf(`${REPO}#1730`)).filter((r) => !r.deleted).map((r) => r.text)).toEqual(['留着的', '会被删的'])
    w.now = '2026-11-25T13:00:00.000Z'
    await pollRepo(REPO, dir, readerOf(w), deliver())
    await settled()
    expect((await repliesOf(`${REPO}#1730`)).filter((r) => !r.deleted).map((r) => r.text)).toEqual(['留着的'])
  })
})
