import { parseArgs } from 'node:util'
import { BoardError, block, type board } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { type DecisionCard, gapsOfADecisionCard, SCHEMAS, type SchemaId } from './schemas.ts'
import { IMPACT_FORMAT, whyNotDeclarable } from './impact.ts'
import { registeredReadings } from './okr.ts'
import { claimReady } from './dispatch.ts'
import { boardDirAsConfiguredWhenAsked } from './server.ts'
import { bodyFrom, Refused, resolve } from './tasks.ts'
import { optionWordsBut, pointAt, withBody } from './hint.ts'

type Run = (argv: string[]) => Promise<number>
type Team = ReturnType<typeof board>
type Thread = Awaited<ReturnType<Team['thread']>>
type Newest = { blocks: { schema: string }[]; text: string }

const KINDS = ['note', 'decision', 'link', 'ask', 'resolve', 'impact'] as const
type Kind = (typeof KINDS)[number]
const HOLD_FOR_PERSON = 'needs_input'
const HOLD_FOR_DECISION = 'awaiting_approval'
const KR_HEADING = /^(.+)=(toward|away|hold)\s*$/
const TRIAGE_LABEL = /^\s*triage:\s*([\w-]+)/
const QUESTION_AFTER_DENGNI = /等你[：:]/
const USAGE = `usage: nawaban event <票> <类> [正文]（类：${KINDS.join(' ')}）`
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
} as const
type Args = ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>['values']

type Event = {
  id: string
  team: Team
  a: Args
  kr: string | undefined
  reply: (text: string) => Promise<number>
  holdFirstThenReply: (reason: string, kind: string, text: string) => Promise<number>
  answerThenLiftIfStillOurs: (kind: string, text: string, ours: (newest: Newest) => boolean) => Promise<number | null>
  holdAndNewest: () => Promise<{ error: number } | { hold: NonNullable<Thread['message']['task']>['blocked']; newest: Thread['message'] }>
}

function refuse(headline: string, code = 1) {
  process.stderr.write(`error: ${headline}\n`)
  return code
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

async function holdAndNewestReply(team: Team, id: string): Promise<{ error: number } | { hold: NonNullable<Thread['message']['task']>['blocked']; newest: Thread['message'] }> {
  try {
    const { message, replies } = await team.thread(id)
    return { hold: message.task?.blocked ?? null, newest: replies.at(-1) ?? message }
  } catch (error) {
    if (error instanceof BoardError) return { error: refuse(`Couldn't read task #${id}: ${error.message}`) }
    throw error
  }
}

async function boardIdByKeyOrId(ref: string): Promise<{ id: string } | { error: number }> {
  try {
    return { id: (await resolve(ref)).id }
  } catch (error) {
    if (error instanceof Refused) return { error: refuse(error.message) }
    throw error
  }
}

function misuse(kind: Kind, a: Args): string | null {
  if (a.by !== undefined && (kind !== 'decision' || a.by !== 'user')) return '--by user goes only with decision'
  if ((a.o !== undefined) !== (kind === 'impact')) return 'an impact takes --o "<O 名>" (纯基础设施写 --o 无), and only an impact does'
  if (a.change !== undefined && kind !== 'impact') return '--change goes only with impact'
  if (kind !== 'impact' && (a.kr?.length ?? 0) > 1) return '--kr goes once, but for an impact'
  return null
}

function eventOn(id: string, a: Args, run: Run, team: Team): Event {
  const as = a.as ? ['--as', a.as] : []
  const reply = (text: string) => run(['reply', id, ...as, '--', text])
  const hold = (reason: string, kind: string) => run(['tasks', 'block', id, '--kind', kind, ...as, '--', reason])
  const holdAndNewest = () => holdAndNewestReply(team, id)

  const unblockAsPersonWhicheverWindowHeld = async () => {
    try {
      await team.as(null).tasks.unblock(id)
    } catch (error) {
      if (error instanceof BoardError) return refuse(`Couldn't unblock task #${id}: ${error.message}`)
      throw error
    }
    process.stdout.write(`unblocked ${id}\n`)
    return 0
  }

  const answerThenLiftIfStillOurs = async (kind: string, text: string, ours: (newest: Newest) => boolean) => {
    const before = await holdAndNewest()
    if ('error' in before) return before.error
    if (before.hold?.kind !== kind) return null
    const posted = await run(['reply', id, '--after', before.newest.id, ...as, '--', text])
    if (posted) return posted
    const after = await holdAndNewest()
    if ('error' in after) return after.error
    const holdRaisedMeanwhile = after.hold?.kind !== kind || !ours(after.newest)
    if (holdRaisedMeanwhile) return refuse(`#${id} changed while answering: answered, hold left as it is`)
    return unblockAsPersonWhicheverWindowHeld()
  }

  const holdFirstThenReply = async (reason: string, kind: string, text: string) => {
    const held = await hold(reason, kind)
    if (held) return held
    const posted = await reply(text)
    const liftHoldThatWouldWaitOnNothing = posted !== 0
    if (liftHoldThatWouldWaitOnNothing) await unblockAsPersonWhicheverWindowHeld()
    return posted
  }

  return { id, team, a, kr: a.kr?.[0], reply, holdFirstThenReply, answerThenLiftIfStillOurs, holdAndNewest }
}

async function note(e: Event): Promise<number> {
  const { a } = e
  if (!a.body) return refuse('a note needs its 正文', 2)
  const body = a.body
  const triage = TRIAGE_LABEL.exec(body)?.[1]
  if (triage === 'needs-info') {
    const question = body.split(QUESTION_AFTER_DENGNI)[1]?.trim() || body
    return e.holdFirstThenReply(question, HOLD_FOR_PERSON, body)
  }
  if (triage === 'ready-for-agent') {
    const held = await e.holdAndNewest()
    if ('error' in held) return held.error
    if (held.hold && held.hold.kind !== HOLD_FOR_PERSON) return refuse(`#${e.id} is held for a decision: resolve it with nawaban event ${e.id} resolve <正文>`)
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

export const askOn = (id: string, card: DecisionCard, as: string | undefined, run: Run, team: Team) => holdForDecision(eventOn(id, { as }, run, team), card)

export async function registration(team: Team, id: string, o: string | undefined, specs: string[], change = 'product'): Promise<{ text: string } | { error: number }> {
  const headings = []
  for (const spec of specs) {
    const [, name, heading] = KR_HEADING.exec(spec) ?? []
    if (!name) return { error: refuse(`--kr is ${IMPACT_FORMAT}: ${spec}`, 2) }
    headings.push({ name: name.trim(), heading: heading! })
  }
  const { channel } = (await team.thread(id, { limit: 1 })).message
  const why = await whyNotDeclarable(boardDirAsConfiguredWhenAsked(), channel, { objective: o ?? '', krs: headings })
  if (why) return { error: refuse(why) }
  const readings = await registeredReadings(team, channel, headings.map((k) => k.name))
  const value = checkedBeforeAnythingLands('nawaban-impact@2', { objective: o, change, krs: headings.map((k) => ({ ...k, ...readings[k.name] })) })
  return 'why' in value ? { error: refuse(`${value.why} (--change product|measure|gold)`, 2) } : value
}

async function impactShapeHereNamesAtTheBoard(e: Event): Promise<number> {
  const { a } = e
  if (a.body || a.context || a.option || a.rec) return refuse('an impact takes only --o, --kr and --change', 2)
  const value = await registration(e.team, e.id, a.o, a.kr ?? [], a.change)
  return 'error' in value ? value.error : e.reply(value.text)
}

async function resolveDecision(e: Event): Promise<number> {
  const words = checkedBeforeAnythingLands('nawaban-resolve@1', { words: e.a.body })
  if ('why' in words) return refuse(words.why)
  return (
    (await e.answerThenLiftIfStillOurs(HOLD_FOR_DECISION, words.text, (newest) => newest.blocks.some((b) => b.schema === 'nawaban-resolve'))) ??
    refuse(`#${e.id} has no decision waiting`)
  )
}

const BY_KIND: Record<Kind, (e: Event) => Promise<number>> = {
  note,
  decision,
  link,
  ask,
  impact: impactShapeHereNamesAtTheBoard,
  resolve: resolveDecision,
}

async function bodyElseRefusal(positional: string | undefined, values: Args): Promise<{ body: string | undefined } | { error: number }> {
  try {
    return { body: await bodyFrom(positional, values.body, undefined) }
  } catch (error) {
    return { error: refuse((error as Error).message, error instanceof Refused ? error.code : 1) }
  }
}

export async function event(argv: string[], run: Run, team: Team): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, tokens: true })
  } catch (error) {
    return refuse((error as Error).message, 2)
  }
  const { values, positionals, tokens } = parsed
  const [ref, kindWord, bodyWord, ...extra] = positionals
  if (kindWord !== undefined && values.kind !== undefined && kindWord !== values.kind) {
    return refuse(`类给了两次且不一致：位置参数 ${kindWord}，--kind ${values.kind}`, 2)
  }
  const kind = (kindWord ?? values.kind) as Kind
  if (!ref || extra.length || !KINDS.includes(kind)) return refuse(USAGE, 2)
  const body = await bodyElseRefusal(bodyWord, values)
  if ('error' in body) return body.error
  if (values.kind !== undefined || values.body !== undefined) {
    pointAt(withBody(['event', ref, kind], values.body ?? bodyWord, optionWordsBut(tokens, THE_OLD_FLAGS_A_POSITIONAL_REPLACES)))
  }
  const a: Args = { ...values, kind, body: body.body }
  const task = await boardIdByKeyOrId(ref)
  if ('error' in task) return task.error
  const why = misuse(kind, a)
  if (why) return refuse(why, 2)
  return BY_KIND[kind](eventOn(task.id, a, run, team))
}

export async function claimRegistering(argv: string[], claim: Run, run: Run, team: Team): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { o: { type: 'string' }, kr: { type: 'string', multiple: true }, change: { type: 'string' }, release: { type: 'boolean' }, json: { type: 'boolean' }, ready: { type: 'boolean' }, wait: { type: 'string' }, project: { type: 'string' } },
    })
  } catch (error) {
    return refuse((error as Error).message, 2)
  }
  const { o, kr, change, release, json, ready, wait, project } = parsed.values
  if (ready) {
    if (parsed.positionals.length || o !== undefined || kr || change || release) return refuse('--ready claims the next ticket for you: no <票>, and not with --o, --kr, --change or --release', 2)
    return claimReady(wait, project, !!json).catch((error) => refuse((error as Error).message, error instanceof Refused ? error.code : 1))
  }
  if (wait !== undefined || project !== undefined) return refuse('--wait and --project go with --ready', 2)
  const plain = [...parsed.positionals, ...(release ? ['--release'] : []), ...(json ? ['--json'] : [])]
  if (o === undefined) return kr || change ? refuse('--kr and --change register an impact, and go with --o "<O 名>"', 2) : claim(plain)
  if (release) return refuse('--o registers an impact as the task is claimed, not released', 2)
  const task = await boardIdByKeyOrId(parsed.positionals[0] ?? '')
  if ('error' in task) return task.error
  const value = await registration(team, task.id, o, kr ?? [], change)
  if ('error' in value) return value.error
  return (await claim(plain)) || run(['reply', task.id, value.text])
}
