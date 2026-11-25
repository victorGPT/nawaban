import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { checkValue, findBlocks } from '@vercel/board/schemas'
import { whyToSendBack } from '../src/ask-guard.ts'
import { Refused } from '../src/said.ts'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas, SCHEMAS } from '../src/schemas.ts'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const SECRET = 'test-secret'
const SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const SESSIONS_PROFILE = 'cc-aaaa1111'
const REQUEST = 'nawaban-ask-request@1'
const EVERY_CASE_STARTS_A_NODE = { timeout: 60_000 }
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let env: Record<string, string> = {}
let tmp = ''
let tickets = 0

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  tmp = await mkdtemp(join(tmpdir(), 'nawaban-ask-guard-'))
  await mkdir(join(tmp, 'board'))
  env = { PATH: process.env.PATH!, HOME: tmp, BOARD_URL: url, BOARD_TOKEN: SECRET, NAWABAN_BOARD_DIR: join(tmp, 'board'), XDG_CONFIG_HOME: join(tmp, 'config') }
})
afterAll(() => server.close())

function node(argv: string[], input: string) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    const child = execFile('node', [CLI, ...argv], { env }, (error, out, err) => done({ code: error ? Number(error.code) : 0, out, err }))
    child.stdin!.end(input)
  })
}

async function guard(reply: string, more: Record<string, unknown> = {}): Promise<{ decision: string; reason: string } | null> {
  const r = await node(['hook', 'ask-guard'], JSON.stringify({ session_id: SESSION, stop_hook_active: false, cwd: tmp, last_assistant_message: reply, ...more }))
  expect(r.code, r.err).toBe(0)
  expect(r.out.split('\n').filter(Boolean).length).toBeLessThanOrEqual(1)
  return r.out.trim() ? JSON.parse(r.out) : null
}

async function claimAs(profile: string, id: string) {
  const claimed = await node(['board', 'tasks', 'claim', id, '--as', profile], '')
  expect(claimed.code, claimed.err).toBe(0)
}

async function newTicket() {
  const key = `ASK-${++tickets}`
  const { task } = await team.tasks.create('proj', { id: key, text: `ticket ${key}`, labels: { key } })
  return { key, id: task.id }
}

const card = {
  decision: '先合 A 还是先合 B',
  kr: 'O1 / KR1',
  context: 'A 改了接口｜B 只改文档',
  options: [
    { choice: 'A', tradeoff: '快，接口变 | 下游要跟', door: 'two-way' },
    { choice: 'B', tradeoff: '稳', door: 'one-way' },
  ],
  recommendation: 'A，下游已经准备好',
}
const requestFor = (ticket: string, change: Record<string, unknown> = {}) => ({ ticket, ...card, ...change })
const replyWith = (data: Record<string, unknown>) => `两条路都能走。\n\n${block(REQUEST, data)}\n`

async function asksOn(id: string) {
  const { message, replies } = await team.thread(id)
  return { blocked: message.task?.blocked ?? null, asks: replies.flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-ask') }
}

it('lets a reply with no ask block through', EVERY_CASE_STARTS_A_NODE, async () => {
  expect(await guard('两条路都能走，A 快 B 稳。你定用哪个？')).toBeNull()
})

it('lets a block shown in four backticks or a quote through and records nothing', EVERY_CASE_STARTS_A_NODE, async () => {
  const { key, id } = await newTicket()
  const fenced = block(REQUEST, requestFor(key))
  expect(await guard(`格式是这样：\n\n\`\`\`\`\n${fenced}\n\`\`\`\`\n`)).toBeNull()
  expect(await guard(`他写的是：\n\n${fenced.split('\n').map((l) => '> ' + l).join('\n')}\n`)).toBeNull()
  expect(await asksOn(id)).toEqual({ blocked: null, asks: [] })
})

it('records a ready block on a ticket nothing holds, as the card it carries, and lets it through', EVERY_CASE_STARTS_A_NODE, async () => {
  const { key, id } = await newTicket()
  expect(await guard(replyWith(requestFor(key)))).toBeNull()
  const { blocked, asks } = await asksOn(id)
  expect(blocked).toMatchObject({ kind: 'awaiting_approval' })
  expect(asks.map((a) => a.data)).toEqual([card])

  expect(await guard(replyWith(requestFor(key)))).toBeNull()
  expect((await asksOn(id)).asks).toHaveLength(1)
})

it('lets a block through on a ticket already waiting for the person, and records nothing', EVERY_CASE_STARTS_A_NODE, async () => {
  const { key, id } = await newTicket()
  const waiting = await node(['event', key, 'note', 'triage: needs-info — 等你：region?'], '')
  expect(waiting.code, waiting.err).toBe(0)
  expect(await guard(replyWith(requestFor(key)))).toBeNull()
  expect(await asksOn(id)).toMatchObject({ blocked: { kind: 'needs_input' }, asks: [] })
})

it('records it as the session that holds the ticket', EVERY_CASE_STARTS_A_NODE, async () => {
  const { key, id } = await newTicket()
  await claimAs(SESSIONS_PROFILE, id)
  expect(await guard(replyWith(requestFor(key)))).toBeNull()
  expect(await asksOn(id)).toMatchObject({ blocked: { kind: 'awaiting_approval' } })
})

it('sends it back with the refusal when the ask cannot be recorded', EVERY_CASE_STARTS_A_NODE, async () => {
  const { key, id } = await newTicket()
  await claimAs('cc-bbbb2222', id)
  const sent = await guard(replyWith(requestFor(key)))
  expect(sent?.decision).toBe('block')
  expect(sent?.reason).toMatch(new RegExp(`^${key} 记不成待决：\\S`))
  expect((await asksOn(id)).asks).toEqual([])
})

describe('a block that does not match its schema is sent back with the schema error', () => {
  const two = requestFor('ASK-0')
  it.concurrent.each([
    ['missing a field', (() => { const { kr, ...rest } = two; return rest })()],
    ['with a field more', { ...two, owner: 'me' }],
    ['with a door neither one-way nor two-way', { ...two, options: [card.options[0], { ...card.options[1], door: '单向门' }] }],
    ['with one option', { ...two, options: [card.options[0]] }],
  ])('%s', EVERY_CASE_STARTS_A_NODE, async (_, data) => {
    const sent = await guard(replyWith(data as Record<string, unknown>))
    expect(sent?.decision).toBe('block')
    expect(sent?.reason).toContain(checkValue(SCHEMAS[REQUEST].schema, data)!)
    expect(sent?.reason).toContain('"recommendation"')
  })

  it.concurrent('whose JSON does not parse', EVERY_CASE_STARTS_A_NODE, async () => {
    const reply = '要你定：\n\n```json#nawaban-ask-request@1\n{"ticket": "ASK-0", "decision": \n```\n'
    const sent = await guard(reply)
    expect(sent?.decision).toBe('block')
    expect(sent?.reason).toContain(findBlocks(reply)[0]!.problem!)
  })

  it.concurrent('naming a version there is none of', EVERY_CASE_STARTS_A_NODE, async () => {
    const sent = await guard(`\`\`\`json#nawaban-ask-request@2\n${JSON.stringify(two)}\n\`\`\`\n`)
    expect(sent?.reason).toContain('nawaban-ask-request@2 不是 nawaban-ask-request@1')
  })
})

it('sends back a block whose fields say nothing, naming them', EVERY_CASE_STARTS_A_NODE, async () => {
  const { key, id } = await newTicket()
  const sent = await guard(replyWith(requestFor(key, { decision: '无', context: '-', recommendation: '待定' })))
  expect(sent?.decision).toBe('block')
  for (const gap of ['决策事项', '背景', '建议']) expect(sent?.reason).toContain(gap)
  expect((await asksOn(id)).asks).toEqual([])
})

it('sends back a block whose ticket does not exist', EVERY_CASE_STARTS_A_NODE, async () => {
  const sent = await guard(replyWith(requestFor('NO-SUCH-TICKET')))
  expect(sent?.decision).toBe('block')
  expect(sent?.reason).toContain('NO-SUCH-TICKET')
})

it('lets the turn after a send-back through', EVERY_CASE_STARTS_A_NODE, async () => {
  expect(await guard(replyWith({ ticket: 'NO-SUCH-TICKET' }), { stop_hook_active: true })).toBeNull()
})

describe('replies the old guard sent back for their words, with no block, go through', () => {
  it.concurrent.each([
    '这张票按这个口径做不做，等你一句话。',
    '要不要把这件事开成一张票，接在详情页后面做？',
    '拆法可以的话，回「行」，我就从 01 开始派。',
    'KR 只有你能改，草案出来我拿给你看。',
    '全部按建议的话，回「按推荐」就行。worker 已经在票上把这几件记成等你了。',
    '你点头后再开 PR。',
    '你选完方向后，我另开一张票做实现。',
    '卡住要你定的，照旧记成待决。',
    '带了标记、票却没挂着的情况，要被打回。',
    '醒来要你看的三件事，都在待决提示行里。',
  ])('%s', EVERY_CASE_STARTS_A_NODE, async (reply) => {
    expect(await guard(reply)).toBeNull()
  })

  it.concurrent('a reply explaining the block format in four backticks', EVERY_CASE_STARTS_A_NODE, async () => {
    const shown = block(REQUEST, { ticket: '<票>', decision: '<事>', kr: '<KR>', context: '<背景>', options: [], recommendation: '<建议>' })
    expect(await guard(`要我拍板时，回复里放这样一个块：\n\n\`\`\`\`\n${shown}\n\`\`\`\`\n你定就行。`)).toBeNull()
  })
})

it('records a real block in an everyday reply and lets it through', EVERY_CASE_STARTS_A_NODE, async () => {
  const { key, id } = await newTicket()
  expect(await guard(`A 和 B 都测过了，你定用哪个？\n\n${block(REQUEST, requestFor(key))}\n`)).toBeNull()
  expect((await asksOn(id)).asks.map((a) => a.data)).toEqual([card])
})

describe('on a repository the old CLI tracks', () => {
  const asked: string[][] = []
  const trackersRefusingWith = (refusal: string | null) => ({
    run: async () => 1,
    team,
    onOldCli: true,
    oldCli: async (_repo: string, args: string[]) => {
      asked.push(args)
      if (refusal) throw new Refused(refusal)
      return ''
    },
  })
  const stop = { session_id: SESSION, cwd: '/repo', last_assistant_message: replyWith(requestFor('#7')) }

  it('records the ask with the old CLI and lets it through', async () => {
    expect(await whyToSendBack(stop, trackersRefusingWith(null))).toBeNull()
    expect(asked.at(-1)).toEqual([
      'event', '#7', '--kind', 'ask', `--body=${card.decision}`, `--kr=${card.kr}`, `--context=${card.context}`,
      '--option=A｜快，接口变 | 下游要跟｜双向门', '--option=B｜稳｜单向门', `--rec=${card.recommendation}`,
    ])
  })

  it('lets it through when the issue already has an ask waiting', async () => {
    expect(await whyToSendBack(stop, trackersRefusingWith('#7 已有待决,一个 issue 只放一件;先记已决(决策记录),或开子 issue'))).toBeNull()
  })

  it('sends it back with any other refusal', async () => {
    expect(await whyToSendBack(stop, trackersRefusingWith('gh down'))).toBe('#7 记不成待决：gh down')
  })
})
