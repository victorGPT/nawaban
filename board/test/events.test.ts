import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createApp } from '@vercel/board/cli'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'
import { event } from '../src/events.ts'

const SECRET = 'test-secret'
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let url = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nawaban-events-'))
})
afterAll(() => server.close())

async function nawaban(...argv: string[]) {
  return nawabanWithEventAsTheCliRunsIt({}, ...argv)
}

async function nawabanWithEventAsTheCliRunsIt(env: Record<string, string>, ...argv: string[]) {
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  let failure: { reason: string } | undefined
  let err = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true))
  try {
    const app = createApp({ appName: 'nawaban', onError: (f) => void (failure = f) })
    const code = argv[0] === 'event' ? await event(argv.slice(1), (args) => app.run(args), board()) : await app.run(argv)
    return { code, failure, err }
  } finally {
    out.mockRestore()
    stderr.mockRestore()
    vi.unstubAllEnvs()
  }
}

async function taskWithEachReplysBlocks(id: string) {
  const thread = await team.thread(id)
  return { ...thread.message.task!, replies: thread.replies.map((r) => r.blocks.map((b) => `${b.schema}@${b.version}`).join() || r.text) }
}

async function newTask() {
  return (await team.tasks.create('nawaban', 'events')).task.id
}

const CARD = ['--body', 'ship it?', '--kr', 'O1 / KR1', '--context', 'tests pass', '--option', 'ship｜fast｜two-way', '--option', 'wait｜safe｜two-way']

it('finds a task by its key, as the old CLI and the other verbs name it', async () => {
  const { task } = await team.tasks.create('nawaban', { id: 'EV-KEY-1', text: 'by key', labels: { key: 'EV-KEY-1' } })
  expect((await nawaban('event', 'EV-KEY-1', '--kind', 'note', '--body', 'by its key')).code).toBe(0)
  expect((await team.thread(task.id)).replies.map((r) => r.text)).toEqual(['by its key'])
  expect((await nawaban('event', 'NO-SUCH-KEY', '--kind', 'note', '--body', 'x')).err).toContain('✗ 没有票 NO-SUCH-KEY')
})

it('records a note, a decision, and a link as replies, the last two as blocks', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, 'note', 'halfway')).code).toBe(0)
  expect((await nawaban('event', id, 'decision', '决定：sqlite\n背景：which db?\n否决方案：pg - too big', '--by', 'user')).code).toBe(0)
  expect((await nawaban('event', id, 'link', 'pr:https://github.com/acme/web/pull/1')).code).toBe(0)
  expect((await taskWithEachReplysBlocks(id)).replies).toEqual(['halfway', 'nawaban-decision@1', 'nawaban-link@1'])
  const { replies } = await team.thread(id)
  expect(replies[1]!.blocks[0]!.data).toEqual({ question: 'which db?', verdict: 'sqlite', rejected: ['pg - too big'], by: 'user' })
  expect(replies[2]!.blocks[0]!.data).toEqual({ kind: 'pr', ref: 'https://github.com/acme/web/pull/1' })
})

it.each([
  ['决定：sqlite\n背景：which db?\n否决方案：pg — too big\n影响：one file to back up'],
  ['Decision: sqlite\nContext: which db?\nRejected: pg — too big\nConsequences: one file to back up'],
])('takes a 决策记录 in the --body form, 决定 背景 否决方案 and an optional 影响, or their English names: %j', async (body) => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'decision', '--body', body)).code).toBe(0)
  const { replies } = await team.thread(id)
  expect(replies[0]!.blocks[0]!.data).toEqual({ question: 'which db?', verdict: 'sqlite\n影响：one file to back up', rejected: ['pg — too big'], by: 'agent' })
})

it('takes the doors as 单向门 and 双向门 and keeps them as the schema names them', async () => {
  const id = await newTask()
  const card = ['--body', 'ship it?', '--kr', 'O1 / KR1', '--context', 'tests pass', '--option', 'ship｜fast｜双向门', '--option', 'wait｜safe｜单向门', '--rec', 'ship']
  expect((await nawaban('event', id, '--kind', 'ask', ...card)).code).toBe(0)
  const { replies } = await team.thread(id)
  expect((replies[0]!.blocks[0]!.data as { options: { door: string }[] }).options.map((o) => o.door)).toEqual(['two-way', 'one-way'])
})

it('takes a decision in the older --body form', async () => {
  const id = await newTask()
  const body = 'Question: which db?\nVerdict: sqlite\nRejected: pg - too big\nRejected: none - no'
  expect((await nawaban('event', id, '--kind', 'decision', '--body', body)).code).toBe(0)
  const { replies } = await team.thread(id)
  expect(replies[0]!.blocks[0]!.data).toEqual({ question: 'which db?', verdict: 'sqlite', rejected: ['pg - too big', 'none - no'], by: 'agent' })
  expect((await nawaban('event', id, '--kind', 'decision', '--body', 'just words')).code).toBe(1)
})

it('ends the claim of the window that asks, and refuses one that holds no claim', async () => {
  const id = await newTask()
  expect((await nawaban('tasks', 'claim', id, '--as', 'cc-aaaa1111')).code).toBe(0)
  const other = await nawaban('event', id, '--kind', 'ask', '--as', 'cc-bbbb2222', ...CARD, '--rec', 'ship')
  expect(other.code).toBe(1)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'claimed', replies: [] })

  expect((await nawaban('event', id, '--kind', 'ask', '--as', 'cc-aaaa1111', ...CARD, '--rec', 'ship')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', claim: null, blocked: { kind: 'awaiting_approval' }, replies: ['nawaban-ask@1'] })
})

it('lifts a hold as the person, whatever profile the run writes as', async () => {
  const id = (await team.as('cc-aaaa1111').tasks.create('nawaban', 'by a window')).task.id
  await nawaban('event', id, '--kind', 'ask', '--as', 'cc-aaaa1111', ...CARD, '--rec', 'ship')
  expect((await nawabanWithEventAsTheCliRunsIt({ BOARD_PROFILE: 'cc-zzzz9999' }, 'event', id, '--kind', 'resolve', '--body', 'go')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready' })

  await nawaban('event', id, '--kind', 'note', '--as', 'cc-aaaa1111', '--body', 'triage: needs-info — 等你：region?')
  expect((await nawabanWithEventAsTheCliRunsIt({ BOARD_PROFILE: 'cc-zzzz9999' }, 'event', id, '--kind', 'note', '--body', 'triage: ready-for-agent')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready' })
})

it('refuses a card longer than the decision-maker reads, and writes nothing', async () => {
  const id = await newTask()
  const evidencePile = '回测八次抓到五次。'.repeat(50)
  const ask = await nawaban('event', id, '--kind', 'ask', ...CARD.map((part) => (part === 'tests pass' ? evidencePile : part)), '--rec', 'ship')
  expect(ask.code).toBe(1)
  expect(ask.err).toContain('上限 400')
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', blocked: null, replies: [] })
})

it('refuses a card without --rec, and writes nothing', async () => {
  const id = await newTask()
  const ask = await nawaban('event', id, '--kind', 'ask', ...CARD)
  expect(ask.code).toBe(1)
  expect(ask.err).toContain('未就绪')
  expect(ask.err).toContain('建议')
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', blocked: null, replies: [] })
})

it.each([
  ['--body', '无', '决策事项'],
  ['--context', ' none ', '背景'],
  ['--rec', '-', '建议'],
  ['--kr', ' ', '关联 KR'],
  ['--option', 'wait｜ ｜two-way', '第 2 条的代价'],
  ['--option', 'wait｜-｜two-way', '第 2 条的代价'],
  ['--option', ' ｜safe｜two-way', '第 2 条的方案'],
  ['--option', 'wait｜ N / A ｜two-way', '第 2 条的代价'],
  ['--option', 'wait｜—｜two-way', '第 2 条的代价'],
  ['--option', '待定｜safe｜two-way', '第 2 条的方案'],
  ['--context', '暂无', '背景'],
  ['--context', 'n\u2003o\u0085n\ufeffe', '背景'],
  ['--rec', ' TBD ', '建议'],
])('refuses a card whose %s says nothing (%j), naming it, and writes nothing', async (flag, value, named) => {
  const id = await newTask()
  const card = [...CARD, '--rec', 'ship']
  card[card.lastIndexOf(flag) + 1] = value
  const ask = await nawaban('event', id, '--kind', 'ask', ...card)
  expect(ask.code).toBe(1)
  expect(ask.err).toContain(named)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', blocked: null, replies: [] })
})

it('takes 无 as the KR a card is tied to', async () => {
  const id = await newTask()
  const card = [...CARD, '--rec', 'ship']
  card[card.indexOf('--kr') + 1] = '无'
  expect((await nawaban('event', id, '--kind', 'ask', ...card)).code).toBe(0)
})

it('refuses a card whose option names no door', async () => {
  const id = await newTask()
  const ask = await nawaban('event', id, '--kind', 'ask', ...CARD.slice(0, -1), 'wait｜safe', '--rec', 'ship')
  expect(ask.code).toBe(1)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', replies: [] })
})

it('holds one pending decision a task, until it is resolved', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'ask', ...CARD, '--rec', 'ship')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', blocked: { kind: 'awaiting_approval', reason: 'ship it?' }, replies: ['nawaban-ask@1'] })

  const again = await nawaban('event', id, '--kind', 'ask', ...CARD, '--rec', 'wait')
  expect(again.failure?.reason).toBe('task_blocked')
  expect((await taskWithEachReplysBlocks(id)).replies).toEqual(['nawaban-ask@1'])

  expect((await nawaban('event', id, '--kind', 'resolve', '--body', 'ship it')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', replies: ['nawaban-ask@1', 'nawaban-resolve@1'] })
  expect((await nawaban('event', id, '--kind', 'ask', ...CARD, '--rec', 'ship')).code).toBe(0)
})

it("holds the board's own writers to the card, not only nawaban event", async () => {
  const id = await newTask()
  const card = { decision: 'ship it?', kr: 'O1 / KR1', context: 'tests pass', options: [{ choice: 'ship', tradeoff: 'fast', door: 'two-way' }, { choice: 'wait', tradeoff: 'safe', door: 'two-way' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-ask@1', JSON.stringify(card))).failure?.reason).toBeDefined()
  expect((await taskWithEachReplysBlocks(id)).replies).toEqual([])
})

it('says an unknown task is unknown, as a refusal', async () => {
  const resolve = await nawaban('event', '9999', 'resolve', 'yes')
  expect(resolve.code).toBe(1)
  expect(resolve.err).toBe('✗ 没有票 9999\n  票号照 nawaban list 里的写\n')
})

it("won't let a stale resolve lift the next decision", async () => {
  const id = await newTask()
  await nawaban('event', id, '--kind', 'ask', ...CARD, '--rec', 'ship')
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  const app = createApp({ appName: 'nawaban' })
  const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const quieter = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const run = (args: string[]) => app.run(args)
  const anotherWindowResolvesAndAsksAgainMidResolve = async (args: string[]) => {
    const code = await run(args)
    if (args[0] === 'reply') {
      await event([id, '--kind', 'resolve', '--body', 'go'], run, board())
      await event([id, '--kind', 'ask', ...CARD, '--rec', 'wait'], run, board())
    }
    return code
  }
  try {
    await event([id, '--kind', 'resolve', '--body', 'go'], anotherWindowResolvesAndAsksAgainMidResolve, board())
  } finally {
    quiet.mockRestore()
    quieter.mockRestore()
    vi.unstubAllEnvs()
  }
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', blocked: { kind: 'awaiting_approval' } })
})

it('answers a decision once when two windows resolve it at once', async () => {
  const id = await newTask()
  await nawaban('event', id, '--kind', 'ask', ...CARD, '--rec', 'ship')
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  const app = createApp({ appName: 'nawaban' })
  const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation(() => true)]
  const run = (args: string[]) => app.run(args)
  let raced = false
  const otherWindowAnswersBetweenThisReadAndReply = async (args: string[]) => {
    if (args[0] === 'reply' && !raced) {
      raced = true
      await event([id, '--kind', 'resolve', '--body', 'first'], run, board())
    }
    return run(args)
  }
  let code
  try {
    code = await event([id, '--kind', 'resolve', '--body', 'second'], otherWindowAnswersBetweenThisReadAndReply, board())
  } finally {
    for (const spy of quiet) spy.mockRestore()
    vi.unstubAllEnvs()
  }
  expect(code).toBe(1)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', replies: ['nawaban-ask@1', 'nawaban-resolve@1'] })
})

it('keeps the decision waiting when its answer is refused', async () => {
  const id = await newTask()
  await nawaban('event', id, '--kind', 'ask', ...CARD, '--rec', 'ship')
  expect((await nawaban('event', id, '--kind', 'resolve', '--body', 'x'.repeat(10_001))).code).toBe(1)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', blocked: { kind: 'awaiting_approval', reason: 'ship it?' }, replies: ['nawaban-ask@1'] })
  expect((await nawaban('event', id, '--kind', 'resolve', '--body', 'go')).code).toBe(0)

  await nawaban('event', id, '--kind', 'note', '--body', 'triage: needs-info — 等你：region?')
  expect((await nawaban('event', id, '--kind', 'note', '--body', 'triage: ready-for-agent ' + 'x'.repeat(10_001))).code).toBe(1)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', blocked: { kind: 'needs_input', reason: 'region?' } })
})

it('refuses a resolve with no decision waiting', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'resolve', '--body', 'yes')).code).toBe(1)
  expect((await taskWithEachReplysBlocks(id)).replies).toEqual([])
})

it('hands the claim back while waiting on the user, and lets any profile take it after', async () => {
  const id = await newTask()
  expect((await nawaban('tasks', 'claim', id, '--as', 'cc-aaaa1111')).code).toBe(0)
  const wait = await nawaban('event', id, '--kind', 'note', '--as', 'cc-aaaa1111', '--body', 'triage: needs-info — 等你：which region?')
  expect(wait.code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', claim: null, blocked: { kind: 'needs_input', reason: 'which region?' } })
  const personLiftsHoldOfAGoneWindowWithNoClaimOrProfile = await nawaban('event', id, '--kind', 'note', '--body', 'triage: ready-for-agent')
  expect(personLiftsHoldOfAGoneWindowWithNoClaimOrProfile.code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', blocked: null })
  expect((await nawaban('tasks', 'claim', id, '--as', 'cc-bbbb2222')).code).toBe(0)
})

it('lets the owner wait on a ticket no one holds, and a resolve leaves it in the pool', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, 'wait')).code).toBe(2)
  expect((await nawaban('event', id, 'wait', 'which region?')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', blocked: { kind: 'needs_input', reason: 'which region?' }, replies: ['等你：which region?'] })
  expect((await nawaban('event', id, 'resolve', 'eu')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', blocked: null, for: null, replies: ['等你：which region?', 'nawaban-resolve@1'] })
})

it('resolves the wait an old triage note raised', async () => {
  const id = await newTask()
  await nawaban('event', id, 'note', 'triage: needs-info — 等你：region?')
  expect((await nawaban('event', id, 'resolve', 'eu')).code).toBe(0)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'ready', blocked: null })
})

it("won't lift a pending decision with a triage note", async () => {
  const id = await newTask()
  await nawaban('event', id, '--kind', 'ask', ...CARD, '--rec', 'ship')
  expect((await nawaban('event', id, '--kind', 'note', '--body', 'triage: ready-for-agent')).code).toBe(1)
  expect(await taskWithEachReplysBlocks(id)).toMatchObject({ state: 'blocked', replies: ['nawaban-ask@1'] })
})
