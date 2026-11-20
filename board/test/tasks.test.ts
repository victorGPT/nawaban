import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nawaban-tasks-'))
})
afterAll(() => server.close())
afterEach(() => vi.useRealTimers())

/** Runs a nawaban verb as the window of `session`, with --json; answers its exit code, document, and stderr. */
async function nawaban(argv: string[], session = A_SESSION, env: Record<string, string> = {}) {
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  vi.stubEnv('BOARD_PROFILE', '')
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', session)
  vi.stubEnv('HC_TERMINAL_ID', '')
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
  (await nawaban(['list', '--frontier', '--parent', parent])).json.tasks.map((t: { labels: { key: string } }) => t.labels.key)
const t0 = Date.now()
const later = (ms: number) => vi.useFakeTimers({ toFake: ['Date'], now: t0 + ms })

it('leaves the board CLI its own commands', async () => {
  expect(await run(['whoami'])).toBeUndefined()
  expect(await run(['toString'])).toBeUndefined()
})

it('readies what waited for a cancelled task, and nothing behind that', async () => {
  expect((await nawaban(['create', 'S1', '--title', 'spec', '--project', 'nawaban'])).code).toBe(0)
  expect((await nawaban(['create', 'S1-A', '--title', 'A', '--parent', 'S1'])).code).toBe(0)
  expect((await nawaban(['create', 'S1-B', '--title', 'B', '--parent', 'S1', '--blocked-by', 'S1-A'])).code).toBe(0)
  expect((await nawaban(['create', 'S1-C', '--title', 'C', '--parent', 'S1'])).code).toBe(0)
  expect((await nawaban(['block', 'S1-C', 'S1-B'])).code).toBe(0)
  expect(await frontier('S1')).toEqual(['S1-A'])

  expect((await nawaban(['close', 'S1-A', '--cancelled'])).code).toBe(0)
  expect(await frontier('S1')).toEqual(['S1-B'])
  const c = await nawaban(['show', 'S1-C'])
  expect(c.json.needs.map((t: { labels: { key: string } }) => t.labels.key)).toEqual(['S1-B'])
})

it('hands back a task its window left idle past the lease, and keeps it for a window that renews', async () => {
  await nawaban(['create', 'L-1', '--title', 'idle', '--project', 'nawaban', '--parent', 'S1'])
  await nawaban(['create', 'L-2', '--title', 'busy', '--project', 'nawaban', '--parent', 'S1'])
  expect((await nawaban(['claim', 'L-1'])).code).toBe(0)
  expect((await nawaban(['claim', 'L-2'], B_SESSION)).code).toBe(0)
  expect(await frontier('S1')).not.toContain('L-1')

  later(40 * 60_000)
  expect((await nawaban(['renew', '--session', B_SESSION])).code).toBe(0)
  later(70 * 60_000)
  const ready = await frontier('S1')
  expect(ready).toContain('L-1')
  expect(ready).not.toContain('L-2')
  expect((await nawaban(['claim', 'L-1'], B_SESSION)).code).toBe(0)
})

it('shows who holds a task, what it waits for, what waits for it, and the latest word', async () => {
  await nawaban(['create', 'V-1', '--title', 'first', '--project', 'nawaban'])
  await nawaban(['create', 'V-2', '--title', 'second', '--project', 'nawaban', '--blocked-by', 'V-1'])
  await nawaban(['create', 'V-3', '--title', 'third', '--project', 'nawaban', '--blocked-by', 'V-2'])
  expect((await nawaban(['claim', 'V-1'], A_SESSION, { HC_TERMINAL_ID: 't7' })).code).toBe(0)
  const v1 = (await nawaban(['show', 'V-1'])).json.task
  await team.reply(v1.id, 'halfway there')

  const v2 = await nawaban(['show', 'V-2'])
  expect(v2.json.needs.map((t: { labels: { key: string } }) => t.labels.key)).toEqual(['V-1'])
  expect(v2.json.downstream.map((t: { labels: { key: string } }) => t.labels.key)).toEqual(['V-3'])
  const shown = await nawaban(['show', 'V-1'])
  expect(shown.json.task.task.claim.actor).toBe('local:user:victor+cc-aaaa1111')
  expect(shown.json.task.labels.terminal).toBe('t7')
  expect(shown.json.latest.text).toBe('halfway there')
})

it('closes a task as done only from the window holding it, or when no one does', async () => {
  await nawaban(['create', 'D-1', '--title', 'done', '--project', 'nawaban'])
  await nawaban(['claim', 'D-1'])
  const refused = await nawaban(['close', 'D-1', '--done'], B_SESSION)
  expect(refused.code).toBe(1)
  expect(refused.err).toContain('cc-aaaa1111 via victor')
  expect((await nawaban(['claim', 'D-1', '--release'])).code).toBe(0)
  expect((await nawaban(['close', 'D-1', '--done'], B_SESSION)).code).toBe(0)
  expect((await nawaban(['show', 'D-1'])).json.task.task.state).toBe('completed')
})

it('refuses a NAWABAN_OWNER that is no profile name', async () => {
  const r = await nawaban(['claim', 'D-1'], '', { NAWABAN_OWNER: '1 bad' })
  expect(r.code).toBe(2)
})
