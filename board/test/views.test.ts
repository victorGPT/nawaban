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
import { json } from '../src/views.ts'

// The panel's own logic, run on what json board prints: the contract is what it draws.
const LOGIC = new URL('../../herdr/mods/nawaban-board/logic.js', import.meta.url).href
const { leadersView } = await import(LOGIC)

const SECRET = 'test-secret'
const A = 'aaaa1111-0000-0000-0000-000000000000' // the orchestrator's window, terminal t1
const B = 'bbbb2222-0000-0000-0000-000000000000' // a worker's window, terminal t3
const C = 'cccc3333-0000-0000-0000-000000000000' // another worker's, terminal t4
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

/** Runs `nawaban <argv>` as the window of `session` in Herdr terminal `terminal`; answers its exit code and stdout. */
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
const read = (...argv: string[]) => ok(A, '', 'json', ...argv)

// The keys of the old cli.py board_data's rows (an open one has the five after claimed_at; done has done_at), plus pending.
const BASE = ['id', 'title', 'status', 'project', 'parent', 'session', 'created_at', 'active_at', 'open_blockers', 'terminal', 'leader', 'claimed_at']
const OPEN = [...BASE, 'progress', 'blocked_by', 'waiting', 'decision', 'pending'].sort()
const DONE = [...BASE, 'done_at'].sort()

it('prints the board in the shape the panel reads, and the panel draws the 等你 card and the orchestrator group from it', async () => {
  await ok(A, 't1', 'create', 'S', '--title', '报表迁到新底座', '--project', 'nawaban')
  await ok(A, 't1', 'create', 'S-01', '--title', '第一张', '--parent', 'S')
  await ok(A, 't1', 'create', 'S-02', '--title', '第二张', '--parent', 'S', '--blocked-by', 'S-01')
  await ok(A, 't1', 'create', 'Q', '--title', '要问的', '--project', 'nawaban')
  await ok(A, 't1', 'create', 'P', '--title', '待决的', '--project', 'nawaban')
  await ok(A, 't1', 'create', 'D', '--title', '派出去的', '--project', 'nawaban')

  // S-01: claimed, decided, done; S-02 then held by the orchestrator in t1 with progress.
  await ok(A, 't1', 'claim', 'S-01')
  const s01 = (await read('task', 'S-01')).id
  expect(s01).toBe('S-01')
  const id = async (k: string) => (await team.tasks.list({ state: 'all', label: { key: k } })).tasks[0]!.message.id
  await ok(A, 't1', 'close', 'S-01', '--done')
  await ok(A, 't1', 'claim', 'S-02')
  expect((await nawaban(A, 't1', 'event', await id('S-02'), '--kind', 'decision', '--question', '先迁哪个', '--verdict', '先只读\n第二行', '--rejected', '全迁')).code).toBe(0)
  expect((await nawaban(A, 't1', 'event', await id('S-02'), '--kind', 'note', '--body', 'verify：测试通过')).code).toBe(0)

  // Q: the worker in t3 asks the decision-maker (等你): the hold ends its claim.
  await ok(B, 't3', 'claim', 'Q')
  expect((await nawaban(B, 't3', 'event', await id('Q'), '--kind', 'note', '--body', 'triage: needs-info — 等你：放行吗？', '--as', 'cc-bbbb2222')).code).toBe(0)
  // P: a decision card from the other worker.
  await ok(C, 't4', 'claim', 'P')
  const card = ['event', await id('P'), '--kind', 'ask', '--body', '发不发', '--kr', 'K', '--context', '事实', '--option', '发｜快｜two-way', '--option', '不发｜稳｜two-way', '--rec', '发', '--as', 'cc-cccc3333']
  expect((await nawaban(C, 't4', ...card)).code).toBe(0)
  // D: dispatched by the orchestrator (cc-aaaa1111), not started.
  const d = await id('D')
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  await board().as('cc-aaaa1111').reply(d, block('nawaban-dispatch@1', { worker: 'd', terminal: 't9', accept: '验收' }))
  vi.unstubAllEnvs()

  const data = await read('board', '--project', 'nawaban')
  const all = data.columns.flatMap((c: { tasks: { id: string }[] }) => c.tasks)
  const byId = Object.fromEntries(all.map((t: { id: string }) => [t.id, t]))
  expect(data.columns.map((c: { key: string }) => c.key)).toEqual(['open', 'in_progress', 'done'])
  for (const t of all) expect(Object.keys(t).sort(), t.id).toEqual(t.status === 'done' ? DONE : OPEN)
  expect(byId['S-02']).toMatchObject({ status: 'in_progress', session: 'cc-aaaa1111', terminal: 't1', leader: 'cc-aaaa1111', parent: 'S', blocked_by: [], open_blockers: 0, progress: { body: 'verify：测试通过' } })
  expect(byId['S-01']).toMatchObject({ status: 'done', leader: 'cc-aaaa1111' })
  expect(byId['S-01'].done_at).toBeGreaterThan(0)
  expect(byId['Q']).toMatchObject({ status: 'in_progress', session: 'cc-bbbb2222', terminal: 't3', waiting: '放行吗？', pending: null })
  expect(byId['P']).toMatchObject({ session: 'cc-cccc3333', terminal: 't4', waiting: '发不发', pending: { brief: '发不发', progress: [] } })
  expect(byId['D']).toMatchObject({ status: 'open', session: null, terminal: null, leader: 'cc-aaaa1111', claimed_at: null })
  expect(data.decisions).toEqual([expect.objectContaining({ task: 'S-02', verdict: '先只读\n第二行', owner: false })])

  const now = Math.floor(Date.now() / 1000)
  const agent = (address: string, status: string, tab_name: string) => ({ address, status, tab_name, title: 'claude', space: 'here', seq: 1 })
  const agents = [agent('t1', 'working', '编排'), agent('t3', 'idle', 'worker'), agent('t4', 'idle', 'worker 2')]
  const terminals = agents.map((a) => ({ address: a.address, name: null, parent: null, status: a.status, state: 'live' }))
  const v = leadersView({ agents, terminals, space: 'here', board: data, now, lang: 'zh' })
  expect(v.waiting.map((c: { question: string; focus: string }) => [c.question, c.focus]).sort()).toEqual([
    ['发不发', 't4'],
    ['放行吗？', 't3'],
  ])
  const lead = v.groups.find((g: { leader: string }) => g.leader === 'cc-aaaa1111')
  expect(lead.name).toBe('编排')
  expect(lead.items.map((i: { title: string; state: string }) => [i.title, i.state])).toEqual(
    expect.arrayContaining([['报表迁到新底座', 'current'], ['派出去的', 'todo']]),
  )
  expect(lead.decision.verdict).toBe('先只读')
})

it('counts each project with what waits in it, and finds its db', async () => {
  const { projects } = await read('projects')
  expect(projects).toEqual([{ name: 'nawaban', open: 5, total: 6, waiting: 2 }])
  await writeFile(join(dir, 'local.db'), '')
  expect((await read('db')).db).toMatch(/local\.db$/)
})

it('prints a task with its parent, blockers, notes, decisions and events', async () => {
  const t = await read('task', 'S-02')
  expect(Object.keys(t).sort()).toEqual(['id', 'title', 'body', 'status', 'project', 'session', 'created_at', 'parent', 'children', 'blocked_by', 'dependents', 'latest_note', 'decisions', 'links', 'events'].sort())
  expect(t).toMatchObject({ id: 'S-02', status: 'in_progress', session: 'cc-aaaa1111', parent: { id: 'S', status: 'open' }, blocked_by: [{ id: 'S-01', status: 'done' }], latest_note: { kind: 'note', body: 'verify：测试通过' } })
  expect((await read('task', 'S-02')).decisions[0].body).toBe('Question: 先迁哪个\nVerdict: 先只读\n第二行\nRejected: 全迁')
  expect((await read('task', 'S')).children.map((c: { id: string }) => c.id)).toEqual(['S-01', 'S-02'])
  const missing = await nawaban(A, '', 'json', 'task', 'NOPE')
  expect([missing.code, JSON.parse(missing.out).error]).toEqual([1, '任务不存在:NOPE'])
})
