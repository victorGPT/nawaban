import { mkdtemp } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { listen, verifier } from '../src/server.ts'
import { run } from '../src/tasks.ts'

const SECRET = 'test-secret'
const A_SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const B_SESSION = 'bbbb2222-0000-0000-0000-000000000000'
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let url = ''
let boardDir = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nawaban-tasks-'))
  boardDir = await mkdtemp(join(tmpdir(), 'nawaban-tasks-board-'))
})
afterAll(() => server.close())
afterEach(() => vi.useRealTimers())

async function nawabanAsTheWindowOfSession(argv: string[], session = A_SESSION, env: Record<string, string> = {}) {
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  vi.stubEnv('BOARD_PROFILE', '')
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', session)
  vi.stubEnv('HC_TERMINAL_ID', '')
  vi.stubEnv('NAWABAN_BOARD_DIR', boardDir)
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  let out = ''
  let err = ''
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true))
  const warn = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true))
  try {
    const code = await run([...argv, '--json'])
    return { code, json: out ? JSON.parse(out.trim().split('\n').at(-1)!) : undefined, err }
  } finally {
    write.mockRestore()
    warn.mockRestore()
    vi.unstubAllEnvs()
  }
}
const frontier = async (parent: string) =>
  (await nawabanAsTheWindowOfSession(['list', '--frontier', '--parent', parent])).json.tasks.map((t: { labels: { key: string } }) => t.labels.key)
const t0 = Date.now()
const later = (ms: number) => vi.useFakeTimers({ toFake: ['Date'], now: t0 + ms })

it('leaves the board CLI its own commands', async () => {
  expect(await run(['whoami'])).toBeUndefined()
  expect(await run(['toString'])).toBeUndefined()
})

it('readies what waited for a cancelled task, and nothing behind that', async () => {
  expect((await nawabanAsTheWindowOfSession(['create', 'S1', '--title', 'spec', '--project', 'nawaban'])).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['create', 'S1-A', '--title', 'A', '--parent', 'S1'])).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['create', 'S1-B', '--title', 'B', '--parent', 'S1', '--blocked-by', 'S1-A'])).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['create', 'S1-C', '--title', 'C', '--parent', 'S1'])).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['block', 'S1-C', 'S1-B'])).code).toBe(0)
  expect(await frontier('S1')).toEqual(['S1-A'])

  expect((await nawabanAsTheWindowOfSession(['close', 'S1-A', '--cancelled'])).code).toBe(0)
  expect(await frontier('S1')).toEqual(['S1-B'])
  const c = await nawabanAsTheWindowOfSession(['show', 'S1-C'])
  expect(c.json.needs.map((t: { labels: { key: string } }) => t.labels.key)).toEqual(['S1-B'])
})

it('readies what waited for two tasks cancelled at once', async () => {
  await nawabanAsTheWindowOfSession(['create', 'X-A', '--title', 'A', '--project', 'nawaban'])
  await nawabanAsTheWindowOfSession(['create', 'X-B', '--title', 'B', '--project', 'nawaban'])
  await nawabanAsTheWindowOfSession(['create', 'X-D', '--title', 'D', '--project', 'nawaban', '--blocked-by', 'X-A', '--blocked-by', 'X-B'])
  const id = (k: string) => nawabanAsTheWindowOfSession(['show', k]).then((r) => r.json.task.id)
  const a = await id('X-A')
  const b = await id('X-B')
  await Promise.all([team.tasks.cancel(a, 'raced'), team.tasks.cancel(b, 'raced')])
  expect((await nawabanAsTheWindowOfSession(['close', 'X-A', '--cancelled'])).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['show', 'X-D'])).json.task.task.state).toBe('ready')
})

it('hands back a task its window left idle past the lease, and keeps it for a window that renews', async () => {
  await nawabanAsTheWindowOfSession(['create', 'L-1', '--title', 'idle', '--project', 'nawaban', '--parent', 'S1'])
  await nawabanAsTheWindowOfSession(['create', 'L-2', '--title', 'busy', '--project', 'nawaban', '--parent', 'S1'])
  expect((await nawabanAsTheWindowOfSession(['claim', 'L-1'])).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['claim', 'L-2'], B_SESSION)).code).toBe(0)
  expect(await frontier('S1')).not.toContain('L-1')

  later(40 * 60_000)
  expect((await nawabanAsTheWindowOfSession(['renew', '--session', B_SESSION])).code).toBe(0)
  later(70 * 60_000)
  const ready = await frontier('S1')
  expect(ready).toContain('L-1')
  expect(ready).not.toContain('L-2')
  expect((await nawabanAsTheWindowOfSession(['claim', 'L-1'], B_SESSION)).code).toBe(0)
})

it('shows who holds a task, what it waits for, what waits for it, and the latest word', async () => {
  await nawabanAsTheWindowOfSession(['create', 'V-1', '--title', 'first', '--project', 'nawaban'])
  await nawabanAsTheWindowOfSession(['create', 'V-2', '--title', 'second', '--project', 'nawaban', '--blocked-by', 'V-1'])
  await nawabanAsTheWindowOfSession(['create', 'V-3', '--title', 'third', '--project', 'nawaban', '--blocked-by', 'V-2'])
  expect((await nawabanAsTheWindowOfSession(['claim', 'V-1'], A_SESSION, { HC_TERMINAL_ID: 't7' })).code).toBe(0)
  const v1 = (await nawabanAsTheWindowOfSession(['show', 'V-1'])).json.task
  await team.reply(v1.id, 'halfway there')

  const v2 = await nawabanAsTheWindowOfSession(['show', 'V-2'])
  expect(v2.json.needs.map((t: { labels: { key: string } }) => t.labels.key)).toEqual(['V-1'])
  expect(v2.json.downstream.map((t: { labels: { key: string } }) => t.labels.key)).toEqual(['V-3'])
  const shown = await nawabanAsTheWindowOfSession(['show', 'V-1'])
  expect(shown.json.task.task.claim.actor).toBe('local:user:victor+cc-aaaa1111')
  expect(shown.json.task.labels.terminal).toBe('t7')
  expect(shown.json.latest.text).toBe('halfway there')
})

it('closes a task as done only from the window holding it, or when no one does', async () => {
  await nawabanAsTheWindowOfSession(['create', 'D-1', '--title', 'done', '--project', 'nawaban'])
  await nawabanAsTheWindowOfSession(['claim', 'D-1'])
  const refused = await nawabanAsTheWindowOfSession(['close', 'D-1', '--done'], B_SESSION)
  expect(refused.code).toBe(1)
  expect(refused.err).toContain('cc-aaaa1111 via victor')
  expect((await nawabanAsTheWindowOfSession(['claim', 'D-1', '--release'])).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['close', 'D-1', '--done'], B_SESSION)).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['show', 'D-1'])).json.task.task.state).toBe('completed')
})

it('renews every claim the window holds, though one of them fails', async () => {
  await nawabanAsTheWindowOfSession(['create', 'R-1', '--title', 'no local claim', '--project', 'nawaban'])
  await nawabanAsTheWindowOfSession(['create', 'R-2', '--title', 'local claim', '--project', 'nawaban'])
  const r1 = (await nawabanAsTheWindowOfSession(['show', 'R-1'])).json.task.id
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  await board().as('cc-cccc3333').tasks.claim(r1, { lease: 3600 })
  vi.unstubAllEnvs()
  const C = 'cccc3333-0000'
  expect((await nawabanAsTheWindowOfSession(['claim', 'R-2'], C)).code).toBe(0)
  const before = (await nawabanAsTheWindowOfSession(['show', 'R-2'])).json.task.task.claim.until
  later(10 * 60_000)
  expect((await nawabanAsTheWindowOfSession(['renew', '--session', C])).code).toBe(1)
  expect(Date.parse((await nawabanAsTheWindowOfSession(['show', 'R-2'])).json.task.task.claim.until)).toBeGreaterThan(Date.parse(before))
})

it('renews a Codex claim from the session id the hook passes', async () => {
  const codexThread = 'dddd4444-0000-0000-0000-000000000000'
  await nawabanAsTheWindowOfSession(['create', 'X-1', '--title', 'codex lease', '--project', 'nawaban'])
  expect((await nawabanAsTheWindowOfSession(['claim', 'X-1'], A_SESSION, { CODEX_THREAD_ID: codexThread })).code).toBe(0)
  const before = (await nawabanAsTheWindowOfSession(['show', 'X-1'])).json.task.task.claim.until
  later(10 * 60_000)
  expect((await nawabanAsTheWindowOfSession(['renew', '--session', codexThread])).code).toBe(0)
  expect(Date.parse((await nawabanAsTheWindowOfSession(['show', 'X-1'])).json.task.task.claim.until)).toBeGreaterThan(Date.parse(before))
})

it('closes and renews for a NAWABAN_OWNER written in capitals', async () => {
  const owner = { NAWABAN_OWNER: 'Agent-A' }
  await nawabanAsTheWindowOfSession(['create', 'O-1', '--title', 'owner', '--project', 'nawaban'])
  expect((await nawabanAsTheWindowOfSession(['claim', 'O-1'], '', owner)).code).toBe(0)
  expect((await nawabanAsTheWindowOfSession(['close', 'O-1', '--done'], '', owner)).code).toBe(0)
})

it('takes the Codex thread, then the Antigravity conversation, before the Claude Code session they inherited, and that before NAWABAN_OWNER', async () => {
  const codexThread = 'cccc3333-0000-0000-0000-000000000000'
  const holder = async (env: Record<string, string>, session = A_SESSION) => {
    await nawabanAsTheWindowOfSession(['create', 'I-1', '--title', 'identity', '--project', 'nawaban'])
    expect((await nawabanAsTheWindowOfSession(['claim', 'I-1'], session, env)).code).toBe(0)
    const actor = (await nawabanAsTheWindowOfSession(['show', 'I-1'])).json.task.task.claim.actor
    await nawabanAsTheWindowOfSession(['claim', 'I-1', '--release'], session, env)
    return actor.slice(actor.indexOf('+') + 1)
  }
  const antigravityConversation = 'EEEE5555-0000-0000-0000-000000000000'
  expect(await holder({ CODEX_THREAD_ID: codexThread, ANTIGRAVITY_CONVERSATION_ID: antigravityConversation, NAWABAN_OWNER: 'agent-a' })).toBe('cx-cccc3333')
  expect(await holder({ ANTIGRAVITY_CONVERSATION_ID: antigravityConversation, NAWABAN_OWNER: 'agent-a' })).toBe('agy-eeee5555')
  expect(await holder({ NAWABAN_OWNER: 'agent-a' })).toBe('cc-aaaa1111')
  expect(await holder({ NAWABAN_OWNER: 'agent-a' }, '')).toBe('agent-a')
})

it('writes as the OS user from a launchd job with no session and no NAWABAN_OWNER', async () => {
  const noSession = { CODEX_THREAD_ID: '', ANTIGRAVITY_CONVERSATION_ID: '', NAWABAN_OWNER: '' }
  await nawabanAsTheWindowOfSession(['create', 'NIGHTLY-1', '--title', 'nightly', '--project', 'nawaban'])
  const c = await nawabanAsTheWindowOfSession(['claim', 'NIGHTLY-1'], '', noSession)
  expect(c.code).toBe(0)
  const actor: string = (await nawabanAsTheWindowOfSession(['show', 'NIGHTLY-1'])).json.task.task.claim.actor
  expect(actor.slice(actor.indexOf('+') + 1)).toBe(userInfo().username.toLowerCase())
})

it('refuses a NAWABAN_OWNER that is no profile name', async () => {
  const r = await nawabanAsTheWindowOfSession(['claim', 'D-1'], '', { NAWABAN_OWNER: '1 bad' })
  expect(r.code).toBe(2)
})
