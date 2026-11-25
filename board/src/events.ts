import { parseArgs } from 'node:util'
import { BoardError, block, type board } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { type DecisionCard, gapsOfADecisionCard, SCHEMAS, type SchemaId } from './schemas.ts'
import { IMPACT_FORMAT, whyNotDeclarable } from './impact.ts'
import { registeredReadings } from './okr.ts'
import { claimReady } from './dispatch.ts'
import { boardDirAsConfiguredWhenAsked } from './server.ts'
import { bodyFrom, key, live, profile, resolve } from './tasks.ts'
import { answer, orRefusal, Refused } from './said.ts'
import { optionWordsBut, pointAt, withBody } from './hint.ts'

type Run = (argv: string[]) => Promise<number>
type Team = ReturnType<typeof board>
type Thread = Awaited<ReturnType<Team['thread']>>
type Newest = { blocks: { schema: string }[]; text: string }

const KINDS = ['note', 'decision', 'link', 'ask', 'wait', 'resolve', 'impact'] as const
type Kind = (typeof KINDS)[number]
const HOLD_FOR_PERSON = 'needs_input'
const HOLD_FOR_DECISION = 'awaiting_approval'
const KR_HEADING = /^(.+)=(toward|away|hold)\s*$/
const TRIAGE_LABEL = /^\s*triage:\s*([\w-]+)/
const QUESTION_AFTER_DENGNI = /等你[：:]/
const WAIT_NOTE = '等你：'
const USAGE = `用法：nawaban event <票> <类> [正文]（类：${KINDS.join(' ')}）`
const DONE_LINE: Record<Kind, string> = { note: '记下进展', decision: '记下决策', link: '记下链接', ask: '记下待决，票挂起等决策者', wait: '记下等你，票挂起等决策者答复', resolve: '记下已决，挂起已解除', impact: '记下 KR 影响声明' }
const THE_OLD_FLAGS_A_POSITIONAL_REPLACES = ['kind', 'body']

const OPTIONS = {
  kind: { type: 'string' },
  body: { type: 'string' },
  by: { type: 'string' },
  kr: { type: 'string', multiple: true },
  o: { type: 'string' },
  change: { type: 'string' },
  context: { type: 'string' },
  option: { type: 'string', multiple: true },
  rec: { type: 'string' },
  as: { type: 'string' },
  json: { type: 'boolean' },
} as const
type Args = ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>['values']

type Event = {
  id: string
  key: string
  team: Team
  a: Args
  kr: string | undefined
  run: Run
  reply: (text: string) => Promise<number>
  holdFirstThenReply: (reason: string, kind: string, text: string) => Promise<number>
  answerThenLiftIfStillOurs: (kind: string, text: string, ours: (newest: Newest) => boolean, beforeLift?: () => Promise<unknown>) => Promise<number | null>
  holdAndNewest: () => Promise<{ hold: NonNullable<Thread['message']['task']>['blocked']; newest: Thread['message'] }>
}

function refuse(headline: string, code = 1, next?: string): never {
  throw new Refused(headline, code, next)
}

function checkedBeforeAnythingLands(id: SchemaId, value: Record<string, unknown>): { text: string } | { why: string } {
  const why = checkValue(SCHEMAS[id].schema, value)
  return why ? { why: `the ${id} block doesn't match its schema: ${why}` } : { text: block(id, value) }
}

const DOOR_AS_THE_SCHEMA_NAMES_IT: Record<string, string> = { 单向门: 'one-way', 双向门: 'two-way', 'one-way door': 'one-way', 'two-way door': 'two-way' }

function cardOption(words: string) {
  const [choice, tradeoff, door] = words.split(/[｜|]/).map((part) => part.trim())
  return { choice, tradeoff, door: door === undefined ? door : (DOOR_AS_THE_SCHEMA_NAMES_IT[door] ?? door) }
}

async function holdAndNewestReply(team: Team, id: string, key: string): Promise<{ hold: NonNullable<Thread['message']['task']>['blocked']; newest: Thread['message'] }> {
  try {
    const { message, replies } = await team.thread(id)
    return { hold: message.task?.blocked ?? null, newest: replies.at(-1) ?? message }
  } catch (error) {
    if (error instanceof BoardError) refuse(`读不到 ${key}：${error.message}`)
    throw error
  }
}

function misuse(kind: Kind, a: Args): string | null {
  if (a.by !== undefined && (kind !== 'decision' || a.by !== 'user')) return '--by user 只跟 decision 一起用'
  if ((a.o !== undefined) !== (kind === 'impact')) return 'impact 要 --o "<O 名>"（纯基础设施写 --o 无），也只有 impact 收 --o'
  if (a.change !== undefined && kind !== 'impact') return '--change 只跟 impact 一起用'
  if (kind !== 'impact' && (a.kr?.length ?? 0) > 1) return '--kr 只给一次，impact 除外'
  return null
}

function eventOn(id: string, key: string, a: Args, run: Run, team: Team): Event {
  const as = a.as ? ['--as', a.as] : []
  const reply = (text: string) => run(['reply', id, ...as, '--', text])
  const hold = (reason: string, kind: string) => run(['tasks', 'block', id, '--kind', kind, ...as, '--', reason])
  const holdAndNewest = () => holdAndNewestReply(team, id, key)

  const unblockAsPersonWhicheverWindowHeld = async () => {
    try {
      await team.as(null).tasks.unblock(id)
    } catch (error) {
      if (error instanceof BoardError) refuse(`解不开 ${key} 的挂起：${error.message}`)
      throw error
    }
    return 0
  }

  const answerThenLiftIfStillOurs = async (kind: string, text: string, ours: (newest: Newest) => boolean, beforeLift = async () => undefined as unknown) => {
    const before = await holdAndNewest()
    if (before.hold?.kind !== kind) return null
    const posted = await run(['reply', id, '--after', before.newest.id, ...as, '--', text])
    if (posted) return posted
    const after = await holdAndNewest()
    const holdRaisedMeanwhile = after.hold?.kind !== kind || !ours(after.newest)
    if (holdRaisedMeanwhile) refuse(`${key} 在答的时候变了：答复记下了，挂起没动`)
    await beforeLift()
    return unblockAsPersonWhicheverWindowHeld()
  }

  const holdFirstThenReply = async (reason: string, kind: string, text: string) => {
    const held = await hold(reason, kind)
    if (held) return held
    const posted = await reply(text).catch((error: unknown) => error)
    const liftHoldThatWouldWaitOnNothing = posted !== 0
    if (liftHoldThatWouldWaitOnNothing) await unblockAsPersonWhicheverWindowHeld().catch(() => undefined)
    if (posted instanceof Error) throw posted
    return posted as number
  }

  return { id, key, team, a, kr: a.kr?.[0], run, reply, holdFirstThenReply, answerThenLiftIfStillOurs, holdAndNewest }
}

async function note(e: Event): Promise<number> {
  const { a } = e
  if (!a.body) return refuse('note 要有正文', 2)
  const body = a.body
  const triage = TRIAGE_LABEL.exec(body)?.[1]
  if (triage === 'needs-info') {
    const question = body.split(QUESTION_AFTER_DENGNI)[1]?.trim() || body
    return e.holdFirstThenReply(question, HOLD_FOR_PERSON, body)
  }
  if (triage === 'ready-for-agent') {
    const held = await e.holdAndNewest()
    if (held.hold && held.hold.kind !== HOLD_FOR_PERSON) return refuse(`${e.key} 挂着等决策`, 1, `用 nawaban event ${e.key} resolve <正文> 记已决`)
    if (!held.hold) return e.reply(body)
    return (await e.answerThenLiftIfStillOurs(HOLD_FOR_PERSON, body, (newest) => newest.text === body)) ?? e.reply(body)
  }
  return e.reply(body)
}

const oldBodyLines = (body: string | undefined, key: string) => [...(body ?? '').matchAll(new RegExp(`^\\s*(?:${key})\\s*[:：]\\s*(.+)$`, 'gm'))].map((m) => m[1]!.trim())

const verdictWithItsConsequences = (verdict: string | undefined, consequences: string | undefined) =>
  verdict && consequences ? `${verdict}\n影响：${consequences}` : verdict

async function decision(e: Event): Promise<number> {
  const { a } = e
  const value = checkedBeforeAnythingLands('nawaban-decision@1', {
    question: oldBodyLines(a.body, '背景|Context|Question')[0],
    verdict: verdictWithItsConsequences(oldBodyLines(a.body, '决定|Decision|Verdict')[0], oldBodyLines(a.body, '影响|Consequences')[0]),
    rejected: oldBodyLines(a.body, '否决方案|Rejected'),
    by: a.by === 'user' ? 'user' : 'agent',
    ...(e.kr ? { kr: e.kr } : {}),
  })
  return 'why' in value ? refuse(`${value.why} (正文写 决定：、背景：、否决方案：，可选 影响：；Decision:/Context:/Rejected:、Question:/Verdict: 照样收)`) : e.reply(value.text)
}

async function link(e: Event): Promise<number> {
  const [, linkKind, ref] = /^(\w+):(.+)$/s.exec(e.a.body ?? '') ?? []
  const value = checkedBeforeAnythingLands('nawaban-link@1', { kind: linkKind, ref })
  return 'why' in value ? refuse(`${value.why} (正文 pr:<url>, commit:<sha>, artifact:<ref>, adr:<ref>)`) : e.reply(value.text)
}

async function holdForDecision(e: Event, value: DecisionCard): Promise<number> {
  const gaps = gapsOfADecisionCard(value)
  if (gaps.length) return refuse(`待决策项未就绪（不满足就绪标准），缺 ${gaps.join('、')}；- / none / 无 / 待定 这类占位算缺（--option 写成 方案｜代价｜单向门 或 双向门）`)
  const card = checkedBeforeAnythingLands('nawaban-ask@1', value as Record<string, unknown>)
  if ('why' in card) return refuse(card.why)
  return e.holdFirstThenReply(String(value.decision), HOLD_FOR_DECISION, card.text)
}

async function ask(e: Event): Promise<number> {
  const { a } = e
  return holdForDecision(e, { decision: a.body, kr: e.kr, context: a.context, options: (a.option ?? []).map(cardOption), recommendation: a.rec })
}

export const askOn = (id: string, card: DecisionCard, as: string | undefined, run: Run, team: Team) => holdForDecision(eventOn(id, id, { as }, run, team), card)

export async function registration(team: Team, id: string, o: string | undefined, specs: string[], change = 'product'): Promise<string> {
  const headings = []
  for (const spec of specs) {
    const [, name, heading] = KR_HEADING.exec(spec) ?? []
    if (!name) refuse(`--kr 写成 ${IMPACT_FORMAT}：${spec}`, 2)
    headings.push({ name: name.trim(), heading: heading! })
  }
  const { channel } = (await team.thread(id, { limit: 1 })).message
  const why = await whyNotDeclarable(boardDirAsConfiguredWhenAsked(), channel, { objective: o ?? '', krs: headings })
  if (why) refuse(why)
  const readings = await registeredReadings(team, channel, headings.map((k) => k.name))
  const value = checkedBeforeAnythingLands('nawaban-impact@2', { objective: o, change, krs: headings.map((k) => ({ ...k, ...readings[k.name] })) })
  return 'why' in value ? refuse(`${value.why}（--change product|measure|gold）`, 2) : value.text
}

async function impactShapeHereNamesAtTheBoard(e: Event): Promise<number> {
  const { a } = e
  if (a.body || a.context || a.option || a.rec) return refuse('impact 只收 --o、--kr、--change', 2)
  return e.reply(await registration(e.team, e.id, a.o, a.kr ?? [], a.change))
}

async function wait(e: Event): Promise<number> {
  const question = e.a.body?.trim()
  if (!question) return refuse('wait 要有一行问题', 2)
  return e.holdFirstThenReply(question, HOLD_FOR_PERSON, `${WAIT_NOTE}${question}`)
}

async function profileThatRaisedTheHold(team: Team, id: string): Promise<string | null> {
  const { channel } = (await team.thread(id, { limit: 1 })).message
  let raisedBy: string | null = null
  for (let after = id; ; ) {
    const { events, cursor } = await team.poll({ channel, after })
    for (const ev of events) {
      const p = ev.payload as { id?: string | number; by?: { profile: string | null } }
      if (ev.type === 'task.blocked' && String(p.id) === id) raisedBy = p.by?.profile ?? null
    }
    if (cursor === after) return raisedBy
    after = cursor
  }
}

async function resolveHold(e: Event): Promise<number | string> {
  const words = checkedBeforeAnythingLands('nawaban-resolve@1', { words: e.a.body })
  if ('why' in words) return refuse(words.why)
  const ours = (newest: Newest) => newest.blocks.some((b) => b.schema === 'nawaban-resolve')
  const { hold } = await e.holdAndNewest()
  if (hold?.kind !== HOLD_FOR_PERSON) return (await e.answerThenLiftIfStillOurs(HOLD_FOR_DECISION, words.text, ours)) ?? refuse(`${e.key} 没有挂着等决策或等你的事`)
  const holder = await profileThatRaisedTheHold(e.team, e.id)
  let back: string | null = null
  const assignBackBeforeTheLiftSoNoOtherClaimSlipsIn = async () => {
    if (holder) back = await e.run(['tasks', 'assign', e.id, holder]).then((code) => (code ? null : holder), () => null)
  }
  const code = await e.answerThenLiftIfStillOurs(HOLD_FOR_PERSON, words.text, ours, assignBackBeforeTheLiftSoNoOtherClaimSlipsIn)
  if (code === null) return refuse(`${e.key} 没有挂着等决策或等你的事`)
  if (code) return code
  return back ? `，指回 ${back}` : '，留在池里'
}

const BY_KIND: Record<Kind, (e: Event) => Promise<number | string>> = {
  note,
  decision,
  link,
  ask,
  impact: impactShapeHereNamesAtTheBoard,
  wait,
  resolve: resolveHold,
}

export function event(argv: string[], run: Run, team: Team): Promise<number> {
  return answer(argv, async () => {
    const { values, positionals, tokens } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, tokens: true })
    const [ref, kindWord, bodyWord, ...extra] = positionals
    if (kindWord !== undefined && values.kind !== undefined && kindWord !== values.kind) {
      refuse(`类给了两次且不一致：位置参数 ${kindWord}，--kind ${values.kind}`, 2)
    }
    const kind = (kindWord ?? values.kind) as Kind
    if (!ref || extra.length || !KINDS.includes(kind)) refuse(USAGE, 2)
    const body = await bodyFrom(bodyWord, values.body, undefined)
    if (values.kind !== undefined || values.body !== undefined) {
      pointAt(withBody(['event', ref, kind], values.body ?? bodyWord, optionWordsBut(tokens, THE_OLD_FLAGS_A_POSITIONAL_REPLACES)))
    }
    const task = await resolve(ref)
    const holderWaitsWithItsClaimSinceOnlyTheClaimMayHoldAClaimedTask = kind === 'wait' && values.as === undefined && live(task)
    const a: Args = { ...values, kind, body, ...(holderWaitsWithItsClaimSinceOnlyTheClaimMayHoldAClaimedTask ? { as: profile() } : {}) }
    const why = misuse(kind, a)
    if (why) refuse(why, 2)
    const got = await BY_KIND[kind](eventOn(task.id, key(task), a, run, team))
    if (typeof got === 'number' && got) refuse(`看板没记下 ${key(task)} 的 ${kind}`, got)
    return { done: `${key(task)} ${DONE_LINE[kind]}${typeof got === 'string' ? got : ''}`, json: { key: key(task), id: task.id, kind } }
  })
}

export function claimRegistering(argv: string[], claim: Run, run: Run, team: Team): Promise<number> {
  return orRefusal(argv, async () => {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { o: { type: 'string' }, kr: { type: 'string', multiple: true }, change: { type: 'string' }, release: { type: 'boolean' }, json: { type: 'boolean' }, ready: { type: 'boolean' }, wait: { type: 'string' }, project: { type: 'string' } },
    })
    const { o, kr, change, release, json, ready, wait, project } = parsed.values
    if (ready) {
      if (parsed.positionals.length || o !== undefined || kr || change || release) refuse('--ready 领指派给你的下一张：不带 <票>，也不跟 --o、--kr、--change、--release 一起用', 2)
      return answer(argv, () => claimReady(wait, project))
    }
    if (wait !== undefined || project !== undefined) refuse('--wait 和 --project 只跟 --ready 一起用', 2)
    const plain = [...parsed.positionals, ...(release ? ['--release'] : []), ...(json ? ['--json'] : [])]
    if (o === undefined) return kr || change ? refuse('--kr 和 --change 登记 KR 影响，要跟 --o "<O 名>" 一起用', 2) : claim(plain)
    if (release) refuse('--o 在认领时登记 KR 影响，不跟 --release 一起用', 2)
    const task = await resolve(parsed.positionals[0] ?? '')
    const registered = await registration(team, task.id, o, kr ?? [], change)
    return (await claim(plain)) || run(['reply', task.id, registered])
  })
}
