import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createApp } from '@vercel/board/cli'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'
import { event } from '../src/events.ts'
import { run } from '../src/tasks.ts'
import { json, taskDetail } from '../src/views.ts'
import { pullStateFromGitHub, pullStateOfAView } from '../src/pulls.ts'

const PANELS_OWN_LOGIC_SO_THE_CONTRACT_IS_WHAT_IT_DRAWS = new URL('../../herdr/mods/nawaban-board/logic.js', import.meta.url).href
const { panelView, decisionCardsView } = await import(PANELS_OWN_LOGIC_SO_THE_CONTRACT_IS_WHAT_IT_DRAWS)

const SECRET = 'test-secret'
const ORCHESTRATOR_WINDOW_IN_T1 = 'aaaa1111-0000-0000-0000-000000000000'
const WORKER_WINDOW_IN_T3 = 'bbbb2222-0000-0000-0000-000000000000'
const OTHER_WORKER_WINDOW_IN_T4 = 'cccc3333-0000-0000-0000-000000000000'
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let url = ''
let dir = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nawaban-views-'))
  dir = await mkdtemp(join(tmpdir(), 'nawaban-views-board-'))
})
afterAll(() => server.close())

async function nawaban(session: string, terminal: string, ...argv: string[]) {
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  vi.stubEnv('BOARD_PROFILE', '')
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', session)
  vi.stubEnv('HC_TERMINAL_ID', terminal)
  vi.stubEnv('NAWABAN_BOARD_DIR', dir)
  let out = ''
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true))
  const warn = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (process.env.DEBUG_VIEWS && console.log(String(chunk)), true))
  try {
    const app = createApp({ appName: 'nawaban' })
    const code =
      argv[0] === 'event'
        ? await event(argv.slice(1), (args) => app.run(args), board())
        : argv[0] === 'json'
          ? await json(argv.slice(1), board(), dir)
          : ((await run(argv)) ?? (await app.run(argv)))
    return { code, out: out.trim().split('\n').at(-1)! }
  } finally {
    write.mockRestore()
    warn.mockRestore()
    vi.unstubAllEnvs()
  }
}
const ok = async (session: string, terminal: string, ...argv: string[]) => {
  const r = await nawaban(session, terminal, ...argv)
  expect(r.code, argv.join(' ')).toBe(0)
  return argv[0] === 'json' ? JSON.parse(r.out) : null
}
const read = (...argv: string[]) => ok(ORCHESTRATOR_WINDOW_IN_T1, '', 'json', ...argv)

const OLD_BOARD_DATA_ROW_KEYS = ['id', 'title', 'status', 'project', 'parent', 'session', 'created_at', 'active_at', 'open_blockers', 'terminal', 'leader', 'claimed_at']
const OPEN_ROW_KEYS_PLUS_PENDING = [...OLD_BOARD_DATA_ROW_KEYS, 'progress', 'live', 'ruling', 'blocked_by', 'waiting', 'decision', 'pending'].sort()
const DONE_ROW_KEYS = [...OLD_BOARD_DATA_ROW_KEYS, 'done_at'].sort()

it('prints the board in the shape the panel reads, and the panel draws the 等你 card and the orchestrator group from it', async () => {
  await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'create', 'S', '--title', '报表迁到新底座', '--project', 'nawaban')
  await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'create', 'S-01', '--title', '第一张', '--parent', 'S')
  await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'create', 'S-02', '--title', '第二张', '--parent', 'S', '--blocked-by', 'S-01')
  await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'create', 'Q', '--title', '要问的', '--project', 'nawaban')
  await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'create', 'P', '--title', '待决的', '--project', 'nawaban')
  await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'create', 'D', '--title', '派出去的', '--project', 'nawaban')
  const id = async (k: string) => (await team.tasks.list({ state: 'all', label: { key: k } })).tasks[0]!.message.id

  const s01ClaimedDecidedDoneThenS02HeldByTheOrchestratorWithProgress = async () => {
    await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'claim', 'S-01')
    const s01 = (await read('task', 'S-01')).id
    expect(s01).toBe('S-01')
    await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'close', 'S-01', '--done')
    await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'claim', 'S-02')
    expect((await nawaban(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'event', await id('S-02'), 'decision', '决定：先只读\n背景：先迁哪个\n否决方案：全迁\n影响：第二行')).code).toBe(0)
    expect((await nawaban(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'event', await id('S-02'), '--kind', 'note', '--body', 'verify：测试通过')).code).toBe(0)
  }
  const qWorkerAsksTheDecisionMakerAndTheHoldEndsItsClaim = async () => {
    await ok(WORKER_WINDOW_IN_T3, 't3', 'claim', 'Q')
    expect((await nawaban(WORKER_WINDOW_IN_T3, 't3', 'event', await id('Q'), '--kind', 'note', '--body', 'triage: needs-info — 等你：放行吗？', '--as', 'cc-bbbb2222')).code).toBe(0)
  }
  const pDecisionCardFromTheOtherWorker = async () => {
    await ok(OTHER_WORKER_WINDOW_IN_T4, 't4', 'claim', 'P')
    const card = ['event', await id('P'), '--kind', 'ask', '--body', '发不发', '--kr', 'K', '--context', '事实', '--option', '发｜快｜two-way', '--option', '不发｜稳｜two-way', '--rec', '发', '--as', 'cc-cccc3333']
    expect((await nawaban(OTHER_WORKER_WINDOW_IN_T4, 't4', ...card)).code).toBe(0)
  }
  const dDispatchedByTheOrchestratorNotStarted = async () => {
    const d = await id('D')
    vi.stubEnv('BOARD_URL', url)
    vi.stubEnv('BOARD_TOKEN', SECRET)
    await board().as('cc-aaaa1111').reply(d, block('nawaban-dispatch@1', { worker: 'd', terminal: 't9', accept: '验收' }))
    vi.unstubAllEnvs()
  }
  await s01ClaimedDecidedDoneThenS02HeldByTheOrchestratorWithProgress()
  await qWorkerAsksTheDecisionMakerAndTheHoldEndsItsClaim()
  await pDecisionCardFromTheOtherWorker()
  await dDispatchedByTheOrchestratorNotStarted()

  const data = await read('board', '--project', 'nawaban')
  const all = data.columns.flatMap((c: { tasks: { id: string }[] }) => c.tasks)
  const byId = Object.fromEntries(all.map((t: { id: string }) => [t.id, t]))
  expect(data.columns.map((c: { key: string }) => c.key)).toEqual(['open', 'in_progress', 'done'])
  for (const t of all) expect(Object.keys(t).sort(), t.id).toEqual(t.status === 'done' ? DONE_ROW_KEYS : OPEN_ROW_KEYS_PLUS_PENDING)
  expect(byId['S-02']).toMatchObject({ status: 'in_progress', session: 'cc-aaaa1111', terminal: 't1', leader: 'cc-aaaa1111', parent: 'S', blocked_by: [], open_blockers: 0, progress: { body: 'verify：测试通过' } })
  expect(byId['S-01']).toMatchObject({ status: 'done', leader: 'cc-aaaa1111' })
  expect(byId['S-01'].done_at).toBeGreaterThan(0)
  expect(byId['Q']).toMatchObject({ status: 'in_progress', session: 'cc-bbbb2222', terminal: 't3', waiting: '放行吗？', pending: null })
  expect(byId['P']).toMatchObject({ session: 'cc-cccc3333', terminal: 't4', waiting: '发不发', pending: { brief: '发不发', progress: [] } })
  expect(byId['P'].pending.card).toEqual({ decision: '发不发', kr: 'K', context: '事实', rec: '发',
    options: [{ key: '第 1 项', text: '发', note: '快｜two-way' }, { key: '第 2 项', text: '不发', note: '稳｜two-way' }] })
  expect(byId['D']).toMatchObject({ status: 'open', session: null, terminal: null, leader: 'cc-aaaa1111', claimed_at: null })
  expect(data.decisions).toEqual([expect.objectContaining({ task: 'S-02', verdict: '先只读\n影响：第二行', owner: false })])

  const now = Math.floor(Date.now() / 1000)
  const agent = (address: string, status: string, tab_name: string) => ({ address, status, tab_name, title: 'claude', space: 'here', seq: 1 })
  const agents = [agent('t1', 'working', '编排'), agent('t3', 'idle', 'worker'), agent('t4', 'idle', 'worker 2')]
  const terminals = agents.map((a) => ({ address: a.address, name: null, parent: null, status: a.status, state: 'live' }))
  const v = panelView({ agents, terminals, space: 'here', board: data, now, lang: 'zh' })
  expect(v.waiting.map((c: { question: string; focus: string }) => [c.question, c.focus]).sort()).toEqual([['放行吗？', 't3']])
  expect(decisionCardsView(data).cards.map((c: { title: string }) => c.title)).toEqual(['发不发'])
  const listed = v.tasks.flatMap((g: { group: string; items: { title: string; state: string; where: string | null }[] }) =>
    g.items.map((i) => [g.group, i.title, i.state, i.where]),
  )
  expect(listed).toEqual(expect.arrayContaining([['working', '报表迁到新底座', 'current', '编排'], ['todo', '派出去的', 'todo', null]]))
})

it('counts each project with what waits in it, and finds its db', async () => {
  const { projects } = await read('projects')
  expect(projects).toEqual([{ name: 'nawaban', open: 5, total: 6, waiting: 2 }])
  await writeFile(join(dir, 'local.db'), '')
  expect((await read('db')).db).toMatch(/local\.db$/)
})

it('prints a task with its parent, blockers, notes, decisions and events', async () => {
  const t = await read('task', 'S-02')
  expect(Object.keys(t).sort()).toEqual(['id', 'title', 'body', 'status', 'project', 'session', 'created_at', 'parent', 'children', 'blocked_by', 'dependents', 'latest_note', 'decisions', 'links', 'pulls', 'events', 'narration'].sort())
  expect(t).toMatchObject({ id: 'S-02', status: 'in_progress', session: 'cc-aaaa1111', parent: { id: 'S', status: 'open' }, blocked_by: [{ id: 'S-01', status: 'done' }], latest_note: { kind: 'note', body: 'verify：测试通过' }, narration: [] })
  expect((await read('task', 'S-02')).decisions[0].body).toBe('决定：先只读\n影响：第二行\n背景：先迁哪个\n否决方案：全迁')
  expect((await read('task', 'S')).children.map((c: { id: string }) => c.id)).toEqual(['S-01', 'S-02'])
  const missing = await nawaban(ORCHESTRATOR_WINDOW_IN_T1, '', 'json', 'task', 'NOPE')
  expect([missing.code, JSON.parse(missing.out).error]).toEqual([1, '任务不存在:NOPE'])
})

it('says of each pull request a task links what its reader says, once per address, and nothing where the reader has no answer', async () => {
  await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'create', 'PULLS', '--title', '带 PR 的票', '--project', 'nawaban')
  for (const body of ['pr:https://github.com/o/r/pull/7', 'pr:https://github.com/o/r/pull/7 merged abc1234', 'pr:https://github.com/o/r/pull/8', 'commit:abc1234']) {
    await ok(ORCHESTRATOR_WINDOW_IN_T1, 't1', 'event', 'PULLS', '--kind', 'link', '--body', body)
  }
  const asked: string[] = []
  const detail = await taskDetail(team, 'PULLS', async (url) => (asked.push(url), url.endsWith('/7') ? 'merged' : null))
  expect(asked.sort()).toEqual(['https://github.com/o/r/pull/7', 'https://github.com/o/r/pull/8'])
  expect(detail.pulls).toEqual({ 'https://github.com/o/r/pull/7': 'merged' })
  expect((await read('task', 'PULLS')).pulls).toEqual({})
})

it('reads a pull request as merged, closed, failing its checks or open, and never hands gh anything but a GitHub pull request address', async () => {
  const run = (conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun' as const, name: 'ci', status, conclusion })
  expect([
    pullStateOfAView({ state: 'MERGED', statusCheckRollup: [run('FAILURE')] }),
    pullStateOfAView({ state: 'CLOSED' }),
    pullStateOfAView({ state: 'OPEN', statusCheckRollup: [run('SUCCESS'), run('FAILURE')] }),
    pullStateOfAView({ state: 'OPEN', statusCheckRollup: [run('SUCCESS'), run('', 'IN_PROGRESS')] }),
    pullStateOfAView({ state: 'OPEN', statusCheckRollup: null }),
  ]).toEqual(['merged', 'closed', 'ci_failed', 'open', 'open'])
  expect(await Promise.all(['--web', 'https://example.com/o/r/pull/1', 'https://github.com/o/r/pull/1 --web', 'https://github.com/o/r/issues/1'].map(pullStateFromGitHub))).toEqual([null, null, null, null])
})

it('reads past a long stretch of other projects\' events', async () => {
  for (let i = 0; i < 650; i++) await team.as(null).post('other', 'noise')
  const id = (await team.tasks.list({ state: 'all', label: { key: 'S-02' } })).tasks[0]!.message.id
  await team.as(null).reply(id, '最后的进展')
  const data = await read('board', '--project', 'nawaban')
  const s02 = data.columns.flatMap((c: { tasks: { id: string }[] }) => c.tasks).find((t: { id: string }) => t.id === 'S-02')
  expect(s02.progress.body).toBe('最后的进展')
})
