import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createApp } from '@vercel/board/cli'
import { listen, token, verifier } from '../src/server.ts'

const SECRET = 'test-secret'
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let url = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nawaban-board-'))
})
afterAll(() => server.close())

async function embeddedCliAgainstTheServer(argv: string[], token = SECRET) {
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', token)
  let out = ''
  let failure: { reason: string } | undefined
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true))
  try {
    const code = await createApp({ appName: 'nawaban', onError: (f) => void (failure = f) }).run([...argv, '--json'])
    return { code, json: out ? JSON.parse(out) : undefined, failure }
  } finally {
    write.mockRestore()
    vi.unstubAllEnvs()
  }
}

it('makes one token, 0600, however many first runs race for it', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'nawaban-token-')), 'board')
  const secrets = await Promise.all([token(dir), token(dir), token(dir)])
  expect(new Set(secrets).size).toBe(1)
  expect(secrets[0]).toMatch(/^[0-9a-f]{64}$/)
  expect((await stat(join(dir, 'token'))).mode & 0o777).toBe(0o600)
  expect(await token(dir)).toBe(secrets[0])
})

it('knows the token holder as the OS user, a person', async () => {
  const me = await embeddedCliAgainstTheServer(['whoami'])
  expect(me.code).toBe(0)
  expect(me.json).toMatchObject({ actor: 'local:user:victor', kind: 'person', handle: 'victor' })
})

it('turns away a wrong token', async () => {
  const me = await embeddedCliAgainstTheServer(['whoami'], 'not-the-secret')
  expect(me.code).toBe(1)
  expect(me.failure).toBeDefined()
})

it('hands a task whose lease ran out to another profile, and fences the first', async () => {
  const created = await embeddedCliAgainstTheServer(['tasks', 'create', 'nawaban', 'lease flow'])
  expect(created.code).toBe(0)
  const id: string = created.json.task.id

  const first = await embeddedCliAgainstTheServer(['tasks', 'claim', id, '--as', 'cc-aaaa1111', '--lease', '30s'])
  expect(first.json.task.task.claim.actor).toBe('local:user:victor+cc-aaaa1111')
  expect((await embeddedCliAgainstTheServer(['tasks', 'claim', id, '--as', 'cc-bbbb2222'])).failure?.reason).toBe('task_claimed')

  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 })
  try {
    expect((await embeddedCliAgainstTheServer(['tasks', 'claim', id, '--as', 'cc-bbbb2222'])).code).toBe(0)
    expect((await embeddedCliAgainstTheServer(['tasks', 'complete', id, '--as', 'cc-aaaa1111', 'stale'])).failure?.reason).toBe('claim_lost')
    expect((await embeddedCliAgainstTheServer(['tasks', 'complete', id, '--as', 'cc-bbbb2222', 'done'])).code).toBe(0)
  } finally {
    vi.useRealTimers()
  }
  const done = await embeddedCliAgainstTheServer(['tasks', 'nawaban', '--state', 'completed'])
  expect(done.json.tasks.map((t: { message: { id: string; task: { result: string } } }) => [t.message.id, t.message.task.result])).toEqual([[id, 'done']])
})
