import { parseArgs } from 'node:util'
import { text } from 'node:stream/consumers'
import { block, type board } from '@vercel/board'
import { checkValue, findBlocks, type FoundBlock } from '@vercel/board/schemas'
import { askOn } from './events.ts'
import type { OldCli } from './github.ts'
import { gapsOfADecisionCard, SCHEMAS } from './schemas.ts'
import { live, profilesTheHookSessionMayHold, Refused, resolve, sessionProfile } from './tasks.ts'

type Team = ReturnType<typeof board>
type Run = (argv: string[]) => Promise<number>
type Door = 'one-way' | 'two-way'
type Request = { ticket: string; decision: string; kr: string; context: string; options: { choice: string; tradeoff: string; door: Door }[]; recommendation: string }
export type Stop = { last_assistant_message?: string; session_id?: string; stop_hook_active?: boolean; cwd?: string }
export type Trackers = { run: Run; team: Team; oldCli: OldCli; onOldCli: boolean }

type Reading =
  | { kind: 'broken'; why: string }
  | { kind: 'unready'; gaps: string[] }
  | { kind: 'missing'; ticket: string; why: string }
  | { kind: 'held'; ticket: string }
  | { kind: 'open'; id: string; as: string | undefined; request: Request }
  | { kind: 'old'; request: Request }

const REQUEST = 'nawaban-ask-request@1'
const REQUEST_NAME = 'nawaban-ask-request'
const HOLDS_ALREADY_WAITING_ON_A_PERSON = new Set(['awaiting_approval', 'needs_input'])
const OLD_CLI_REFUSING_A_SECOND_PENDING_ASK = '已有待决'
const DOOR_AS_THE_OLD_CLI_WRITES_IT: Record<Door, string> = { 'one-way': '单向门', 'two-way': '双向门' }
const AGENT_OF_THE_SESSION_BY_ITS_MARK = [['CODEX_THREAD_ID', 'cx'], ['ANTIGRAVITY_CONVERSATION_ID', 'agy']] as const
const SAMPLE = block(REQUEST, {
  ticket: '<票，KEY 或 #N>',
  decision: '<要决策者定的事>',
  kr: '<O / KR>',
  context: '<影响这次决策的事实>',
  options: [
    { choice: '<方案 A>', tradeoff: '<代价>', door: 'two-way' },
    { choice: '<方案 B>', tradeoff: '<代价>', door: 'one-way' },
  ],
  recommendation: '<建议选哪个、为什么>',
})

const cardOf = ({ ticket, ...card }: Request) => card

function agentOfTheSession() {
  return AGENT_OF_THE_SESSION_BY_ITS_MARK.find(([mark]) => process.env[mark])?.[1] ?? 'cc'
}

function profileAsking(task: Awaited<ReturnType<typeof resolve>>, session: string | undefined) {
  if (!session) return undefined
  const claim = live(task)
  const holding = claim && profilesTheHookSessionMayHold(session).find((p) => claim.actor.endsWith(`+${p}`))
  return holding || sessionProfile(agentOfTheSession(), session)
}

async function onTheBoard(request: Request, session: string | undefined): Promise<Reading> {
  let task
  try {
    task = await resolve(request.ticket)
  } catch (error) {
    if (error instanceof Refused) return { kind: 'missing', ticket: request.ticket, why: error.message }
    throw error
  }
  if (HOLDS_ALREADY_WAITING_ON_A_PERSON.has(task.task?.blocked?.kind ?? '')) return { kind: 'held', ticket: request.ticket }
  return { kind: 'open', id: task.id, as: profileAsking(task, session), request }
}

async function readingOf(found: FoundBlock, stop: Stop, onOldCli: boolean): Promise<Reading> {
  if (found.id !== REQUEST) return { kind: 'broken', why: found.problem ?? `${found.id} 不是 ${REQUEST}` }
  if (!found.data) return { kind: 'broken', why: found.problem ?? '块里不是 JSON 对象' }
  const why = checkValue(SCHEMAS[REQUEST].schema, found.data)
  if (why) return { kind: 'broken', why }
  const request = found.data as Request
  const gaps = gapsOfADecisionCard(request)
  if (gaps.length) return { kind: 'unready', gaps }
  return onOldCli ? { kind: 'old', request } : onTheBoard(request, stop.session_id)
}

async function saidOnStderrWithStdoutMuted(work: () => Promise<number>) {
  const { stdout, stderr } = process
  const [out, err] = [stdout.write, stderr.write]
  let said = ''
  stdout.write = (() => true) as typeof stdout.write
  stderr.write = ((chunk: string | Uint8Array) => ((said += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()), true)) as typeof stderr.write
  try {
    return { code: await work(), said: said.trim() }
  } finally {
    stdout.write = out
    stderr.write = err
  }
}

const oldCliAsk = ({ ticket, decision, kr, context, options, recommendation }: Request) => [
  'event',
  ticket,
  '--kind',
  'ask',
  `--body=${decision}`,
  `--kr=${kr}`,
  `--context=${context}`,
  ...options.map((o) => `--option=${o.choice}｜${o.tradeoff}｜${DOOR_AS_THE_OLD_CLI_WRITES_IT[o.door]}`),
  `--rec=${recommendation}`,
]

async function recordedOnTheOldCli(request: Request, stop: Stop, trackers: Trackers): Promise<string | null> {
  try {
    await trackers.oldCli(stop.cwd || process.cwd(), oldCliAsk(request))
    return null
  } catch (error) {
    const why = (error as Error).message
    return why.includes(OLD_CLI_REFUSING_A_SECOND_PENDING_ASK) ? null : `${request.ticket} 记不成待决：${why}`
  }
}

type Answer = { [K in Reading['kind']]: (r: Extract<Reading, { kind: K }>, stop: Stop, trackers: Trackers) => Promise<string | null> }

const SEND_BACK_OR_LET_THROUGH: Answer = {
  broken: async (r) => `回复里的 ${REQUEST} 块不合 schema：${r.why}\n照这个样子写（字段名不变，只换尖括号里的内容）：\n${SAMPLE}`,
  unready: async (r) => `${REQUEST} 块未就绪，缺 ${r.gaps.join('、')}；- / none / 无 / 待定 这类占位算缺`,
  missing: async (r) => `${REQUEST} 块的 ticket 找不到：${r.ticket}（${r.why}）`,
  held: async () => null,
  open: async (r, _stop, { run, team }) => {
    const { code, said } = await saidOnStderrWithStdoutMuted(() => askOn(r.id, cardOf(r.request), r.as, run, team))
    return code ? `${r.request.ticket} 记不成待决：${said}` : null
  },
  old: (r, stop, trackers) => recordedOnTheOldCli(r.request, stop, trackers),
}

const answer = <K extends Reading['kind']>(r: Extract<Reading, { kind: K }>, stop: Stop, trackers: Trackers) =>
  (SEND_BACK_OR_LET_THROUGH[r.kind] as Answer[K])(r, stop, trackers)

const requestsIn = (reply: string) => findBlocks(reply).filter((b) => (b.name ?? b.id.split('@')[0]) === REQUEST_NAME)

export async function whyToSendBack(stop: Stop, trackers: Trackers): Promise<string | null> {
  if (stop.stop_hook_active) return null
  for (const found of requestsIn(stop.last_assistant_message ?? '')) {
    let why
    try {
      why = await answer(await readingOf(found, stop, trackers.onOldCli), stop, trackers)
    } catch (error) {
      why = `${REQUEST} 块记不上，看板读不到：${(error as Error).message}`
    }
    if (why) return why
  }
  return null
}

export async function askGuard(argv: string[], trackers: Omit<Trackers, 'onOldCli'>): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { tracker: { type: 'string' } } })
  let stop: Stop
  try {
    stop = JSON.parse(await text(process.stdin))
  } catch {
    return 0
  }
  const why = await whyToSendBack(stop, { ...trackers, onOldCli: values.tracker === 'old' })
  if (why) process.stdout.write(JSON.stringify({ decision: 'block', reason: why }) + '\n')
  return 0
}
