import { parseArgs } from 'node:util'
import { BoardError, block, type board } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { gapsOfADecisionCard, SCHEMAS, type SchemaId } from './schemas.ts'
import { IMPACT_FORMAT } from './impact.ts'
import { Refused, resolve } from './tasks.ts'

type Run = (argv: string[]) => Promise<number>
type Team = ReturnType<typeof board>
type Thread = Awaited<ReturnType<Team['thread']>>
type Newest = { blocks: { schema: string }[]; text: string }

const KINDS = ['note', 'decision', 'link', 'ask', 'resolve', 'impact'] as const
type Kind = (typeof KINDS)[number]
const HOLD_FOR_PERSON = 'needs_input'
const HOLD_FOR_DECISION = 'awaiting_approval'
const KR_IMPACT_AS_THE_OLD_CLI_TOOK_IT = /^(.+)=([↑↓=])(?:\s+(-?\d+(?:\.\d+)?%?)\s*→\s*(-?\d+(?:\.\d+)?%?)\s+(实测|预计))?\s*$/
const TRIAGE_LABEL = /^\s*triage:\s*([\w-]+)/
const QUESTION_AFTER_DENGNI = /等你[：:]/

const OPTIONS = {
  kind: { type: 'string' },
  body: { type: 'string' },
  by: { type: 'string' },
  kr: { type: 'string', multiple: true },
  o: { type: 'string' },
  question: { type: 'string' },
  verdict: { type: 'string' },
  rejected: { type: 'string', multiple: true },
  context: { type: 'string' },
  option: { type: 'string', multiple: true },
  rec: { type: 'string' },
  as: { type: 'string' },
} as const
type Args = ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>['values']

type Event = {
  id: string
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

function cardOption(words: string) {
  const [choice, tradeoff, door] = words.split(/[｜|]/).map((part) => part.trim())
  return { choice, tradeoff, door }
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
  if (a.by !== undefined && (kind !== 'decision' || a.by !== 'user')) return '--by user goes only with --kind decision'
  if ((a.o !== undefined) !== (kind === 'impact')) return 'an impact takes --o "<O 名>" (纯基础设施写 --o 无), and only an impact does'
  if (kind !== 'impact' && (a.kr?.length ?? 0) > 1) return '--kr goes once, but for an impact'
  return null
}

function eventOn(id: string, a: Args, run: Run, team: Team): Event {
  const as = a.as ? ['--as', a.as] : []
  const reply = (text: string) => run(['reply', id, text, ...as])
  const hold = (reason: string, kind: string) => run(['tasks', 'block', id, reason, '--kind', kind, ...as])
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
    const posted = await run(['reply', id, text, '--after', before.newest.id, ...as])
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

  return { id, a, kr: a.kr?.[0], reply, holdFirstThenReply, answerThenLiftIfStillOurs, holdAndNewest }
}

async function note(e: Event): Promise<number> {
  const { a } = e
  if (!a.body) return refuse('a note needs --body', 2)
  const body = a.body
  const triage = TRIAGE_LABEL.exec(body)?.[1]
  if (triage === 'needs-info') {
    const question = body.split(QUESTION_AFTER_DENGNI)[1]?.trim() || body
    return e.holdFirstThenReply(question, HOLD_FOR_PERSON, body)
  }
  if (triage === 'ready-for-agent') {
    const held = await e.holdAndNewest()
    if ('error' in held) return held.error
    if (held.hold && held.hold.kind !== HOLD_FOR_PERSON) return refuse(`#${e.id} is held for a decision: resolve it with --kind resolve`)
    if (!held.hold) return e.reply(body)
    return (await e.answerThenLiftIfStillOurs(HOLD_FOR_PERSON, body, (newest) => newest.text === body)) ?? e.reply(body)
  }
  return e.reply(body)
}

const oldBodyLines = (body: string | undefined, key: string) => [...(body ?? '').matchAll(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'gm'))].map((m) => m[1]!.trim())

const verdictWithItsConsequences = (verdict: string | undefined, consequences: string | undefined) =>
  verdict && consequences ? `${verdict}\nConsequences: ${consequences}` : verdict

async function decision(e: Event): Promise<number> {
  const { a } = e
  const value = checkedBeforeAnythingLands('nawaban-decision@1', {
    question: a.question ?? oldBodyLines(a.body, 'Context')[0] ?? oldBodyLines(a.body, 'Question')[0],
    verdict: a.verdict ?? verdictWithItsConsequences(oldBodyLines(a.body, 'Decision')[0] ?? oldBodyLines(a.body, 'Verdict')[0], oldBodyLines(a.body, 'Consequences')[0]),
    rejected: a.rejected ?? oldBodyLines(a.body, 'Rejected'),
    by: a.by === 'user' ? 'user' : 'agent',
    ...(e.kr ? { kr: e.kr } : {}),
  })
  return 'why' in value ? refuse(`${value.why} (--body with Decision:, Context:, Rejected: lines and an optional Consequences: line; Question:/Verdict: and --question/--verdict/--rejected still work)`) : e.reply(value.text)
}

async function link(e: Event): Promise<number> {
  const [, linkKind, ref] = /^(\w+):(.+)$/s.exec(e.a.body ?? '') ?? []
  const value = checkedBeforeAnythingLands('nawaban-link@1', { kind: linkKind, ref })
  return 'why' in value ? refuse(`${value.why} (--body pr:<url>, commit:<sha>, artifact:<ref>, adr:<ref>)`) : e.reply(value.text)
}

async function ask(e: Event): Promise<number> {
  const { a } = e
  const value = { decision: a.body, kr: e.kr, context: a.context, options: (a.option ?? []).map(cardOption), recommendation: a.rec }
  const gaps = gapsOfADecisionCard(value)
  if (gaps.length) return refuse(`the Decision Request is not ready (DoR): missing ${gaps.join(', ')} (--option is COA｜cost｜one-way or two-way door)`)
  const card = checkedBeforeAnythingLands('nawaban-ask@1', value)
  if ('why' in card) return refuse(card.why)
  return e.holdFirstThenReply(a.body!, HOLD_FOR_DECISION, card.text)
}

function krsOfImpactArgs(specs: string[]): Record<string, string>[] | { error: number } {
  const krs = []
  for (const spec of specs) {
    const [, name, dir, before, after, basis] = KR_IMPACT_AS_THE_OLD_CLI_TOOK_IT.exec(spec) ?? []
    if (!name) return { error: refuse(`--kr is ${IMPACT_FORMAT}, numbers before→after: ${spec}`, 2) }
    krs.push(Object.fromEntries(Object.entries({ name: name.trim(), dir, before, after, basis }).filter(([, v]) => v !== undefined)) as Record<string, string>)
  }
  return krs
}

async function impactShapeHereNamesAtTheBoard(e: Event): Promise<number> {
  const { a } = e
  if (a.body || a.context || a.option || a.rec || a.question || a.verdict || a.rejected) return refuse('an impact takes only --o and --kr', 2)
  const krs = krsOfImpactArgs(a.kr ?? [])
  if ('error' in krs) return krs.error
  const value = checkedBeforeAnythingLands('nawaban-impact@1', { objective: a.o, krs })
  return 'why' in value ? refuse(`${value.why} (↑↓ need numbers before→after and 实测|预计)`) : e.reply(value.text)
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

export async function event(argv: string[], run: Run, team: Team): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS })
  } catch (error) {
    return refuse((error as Error).message, 2)
  }
  const { values: a, positionals } = parsed
  const ref = positionals[0]
  const kind = a.kind as Kind
  if (!ref || positionals.length > 1 || !KINDS.includes(kind)) {
    return refuse(`usage: nawaban event <key|id> --kind ${KINDS.join('|')} …`, 2)
  }
  const task = await boardIdByKeyOrId(ref)
  if ('error' in task) return task.error
  const why = misuse(kind, a)
  if (why) return refuse(why, 2)
  return BY_KIND[kind](eventOn(task.id, a, run, team))
}
