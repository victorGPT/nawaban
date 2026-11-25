export type Option = { key: string; text: string; note: string }
export type Card = { decision: string; kr: string; context: string; options: Option[]; rec: string }
export type Pending = { at: number; card: Card | null; ask: string | null; brief?: string }
export type WebAnswer = { task: string; option: string | null; words: string; at: string }
export type Reply = { option?: string; words: string }

export const REPLIES = {
  pick: (option: string): Reply => ({ option, words: '就这么定' }),
  unclear: { words: '背景不够，请补写后重发待决' },
  needsOptions: { words: '没法回一句，请补成选项和建议后重发待决' },
  say: (words: string): Reply => ({ words }),
} as const

type HeldTask = { id: string; title: string; status: string; parent?: string | null; session?: string | null; waiting?: string | null; pending?: Pending | null; blocked_by?: string[] }
export type WaitingBoard = { tracker?: 'github'; columns: { key: string; tasks: HeldTask[] }[] }
type OkrKr = { name: string; value: number | string | null; unit?: string | null; target: string }
export type WaitingOkr = { objectives?: { name: string; krs: OkrKr[] }[]; attention?: { kind: string; objective: string; kr: string; text: string }[] }
type Said = { kind: string; body: string; at: number }
export type ProjectReading = { name: string; board: WaitingBoard | null; okr: WaitingOkr | null; asked: Record<string, Said[]> }

export type Choice = { letter: string; text: string; cost: string; oneWay: boolean; sent: string }
export type Advice = { choice: number; why: string }
export type Ticket = { id: string; title: string; state: string }
export type Waiting = {
  project: string
  id: string
  kind: 'card' | 'ask' | 'okr'
  question: string
  since: number | null
  blocks: number
  krs: number
  ask: string | null
  card: { kr: string; context: string; choices: Choice[]; advice: Advice | null } | null
  readings: { name: string; reading: string }[]
  waitsOnThis: Ticket[]
}

const DOOR_NAMES: Record<string, string> = { 'one-way': '单向门', 'two-way': '双向门' }
const TWO_WAY = '双向门'
const ONE_WAY = /^单向门/
const LETTERED = /^([A-Z])\s+([\s\S]*)$/
const CLOSING_STOP = /[。.]$/

export function choicesOf(options: Option[]): Choice[] {
  return options.map((o, i) => {
    const parts = o.note.split('｜').map((p) => p.trim()).filter(Boolean).map((p) => DOOR_NAMES[p] ?? p)
    const [, letter, text] = LETTERED.exec(o.text.trim()) ?? [null, String.fromCharCode(65 + i), o.text.trim()]
    return { letter: letter!, text: text!.replace(CLOSING_STOP, ''), cost: parts.filter((p) => p !== TWO_WAY).join('；'), oneWay: parts.some((p) => ONE_WAY.test(p)), sent: o.text }
  })
}

const CHINESE_ORDINALS = '一二三四五六七八九十'
const LETTER_FIRST = /^\s*(?:选\s*)?([A-Z])(?![A-Za-z])/
const LETTER_AFTER_PICK = /选\s*([A-Z])(?![A-Za-z])/
const ORDINAL = /第\s*([一二三四五六七八九十]|\d+)\s*(?:个|项)/
const ADVICE_LEAD = /^\s*(?:选\s*)?(?:第\s*(?:[一二三四五六七八九十]|\d+)\s*(?:个|项)(?:[（(][^）)]*[）)])?|[A-Z](?![A-Za-z]))[。.，,：:\s]*/
const PREFIX_COMPARED = 8

export function adviceOf(rec: string, choices: Choice[]): Advice | null {
  const why = rec.split('\n')[0]!.replace(ADVICE_LEAD, '').trim()
  const letter = (LETTER_FIRST.exec(rec) ?? LETTER_AFTER_PICK.exec(rec))?.[1]
  const ordinal = ORDINAL.exec(rec)?.[1]
  const byLetter = letter ? choices.findIndex((c) => c.letter === letter) : -1
  const byOrdinal = ordinal ? (/\d/.test(ordinal) ? Number(ordinal) : CHINESE_ORDINALS.indexOf(ordinal) + 1) - 1 : -1
  const head = rec.trim().slice(0, PREFIX_COMPARED)
  const byText = choices.map((c, i) => (c.text.startsWith(head) || head.startsWith(c.text.slice(0, PREFIX_COMPARED)) ? i : -1)).filter((i) => i >= 0)
  const named = [byLetter, byOrdinal].filter((i) => i >= 0 && i < choices.length)
  const choice = named.length ? (new Set(named).size === 1 ? named[0]! : -1) : byText.length === 1 ? byText[0]! : -1
  return choice >= 0 ? { choice, why } : why ? { choice: -1, why } : null
}

export const preselected = (w: Waiting) => {
  const advice = w.card?.advice
  return advice && advice.choice >= 0 && !w.card!.choices[advice.choice]!.oneWay ? w.card!.choices[advice.choice]!.letter : ''
}

const WAIT_OPENING = /^(?:triage:\s*needs-info\b.*?)?等你[：:]|^\s*triage:\s*needs-info\b/
const STATE_WORDS = { done: '已完成', waiting: '等你', working: '进行中', todo: '待办' }

function heldOf(t: HeldTask) {
  return t.status !== 'done' && (t.pending || t.waiting)
}

function waitingOfProject(p: ProjectReading): Waiting[] {
  const tasks = (p.board?.columns ?? []).flatMap((c) => c.tasks)
  const open = tasks.filter((t) => t.status !== 'done')
  const held = open.filter(heldOf)
  const heldIds = new Set(held.map((t) => t.id))
  const stateOf = (t: HeldTask | undefined) => (!t ? '' : t.status === 'done' ? STATE_WORDS.done : heldOf(t) ? STATE_WORDS.waiting : t.session ? STATE_WORDS.working : STATE_WORDS.todo)
  const downstreamOf = (id: string) => {
    const seen = new Set<string>()
    for (const queue = [id]; queue.length; ) {
      const x = queue.pop()!
      for (const t of open) if ((t.blocked_by ?? []).includes(x) && !seen.has(t.id)) (seen.add(t.id), queue.push(t.id))
    }
    return seen
  }
  const github = p.board?.tracker === 'github'
  const tickets = held
    .filter((t) => !(t.parent && heldIds.has(t.parent)))
    .map((t): Waiting => {
      const waiters = [...new Set([...downstreamOf(t.id), ...open.filter((k) => k.parent === t.id).map((k) => k.id)])].sort()
      const full = t.pending?.card ?? null
      const choices = full ? choicesOf(full.options) : []
      const raised = (p.asked[t.id] ?? []).filter((e) => WAIT_OPENING.test(e.body)).reduce((at, e) => Math.max(at, e.at), 0)
      return {
        project: p.name,
        id: t.id,
        kind: full ? 'card' : 'ask',
        question: full ? full.decision.split('\n')[0]! : (t.waiting ?? t.pending?.brief?.split('\n')[0] ?? t.title),
        since: t.pending?.at ?? (raised || null),
        blocks: waiters.length,
        krs: 0,
        ask: t.pending?.ask ?? (t.waiting && !github ? t.waiting : null),
        card: full && { kr: full.kr, context: full.context, choices, advice: adviceOf(full.rec, choices) },
        readings: [],
        waitsOnThis: waiters.map((id) => {
          const x = tasks.find((k) => k.id === id)
          return { id, title: x?.title ?? '', state: stateOf(x) }
        }),
      }
    })
  const krs = (p.okr?.objectives ?? []).flatMap((o) => o.krs)
  const readingOf = (name: string) => {
    const k = krs.find((x) => x.name === name)
    if (!k) return ''
    const unit = k.unit ?? ''
    const target = String(k.target).replace(/>=\s*/, '≥ ').replace(/<=\s*/, '≤ ')
    return ((k.value == null ? '没读数' : k.value + unit) + ' / 目标 ' + target + unit).replace(/(\d)(?=[\u4e00-\u9fff])/g, '$1 ')
  }
  const waits = new Map<string, { objective: string; krs: string[] }>()
  for (const a of p.okr?.attention ?? []) if (a.kind === 'wait') waits.set(a.text, { objective: a.objective, krs: [...(waits.get(a.text)?.krs ?? []), a.kr] })
  const okrWaits = [...waits].map(([text, w]): Waiting => ({
    project: p.name,
    id: 'O「' + w.objective + '」',
    kind: 'okr',
    question: text,
    since: null,
    blocks: 0,
    krs: w.krs.length,
    ask: null,
    card: null,
    readings: w.krs.map((name) => ({ name, reading: readingOf(name) })),
    waitsOnThis: [],
  }))
  return [...tickets, ...okrWaits]
}

export const byDelayCost = (a: Waiting, b: Waiting) =>
  b.blocks - a.blocks || b.krs - a.krs || Number(b.kind === 'card') - Number(a.kind === 'card') || (a.since ?? Infinity) - (b.since ?? Infinity)

export const waitingItems = (projects: ProjectReading[]) => projects.flatMap(waitingOfProject).sort(byDelayCost)

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const waitedFor = (since: number | null, now: number) => {
  if (since == null) return ''
  const s = Math.max(0, now - since)
  return s < HOUR ? Math.round(s / MINUTE) + ' 分钟' : s < DAY ? Math.round(s / HOUR) + ' 小时' : Math.round(s / DAY) + ' 天'
}
export const costOf = (w: Pick<Waiting, 'blocks' | 'krs'>) => (w.blocks ? '挡着 ' + w.blocks + ' 张票' : w.krs ? w.krs + ' 条 KR 量不了' : '')

export function workerOf(events: Said[]) {
  const dispatch = events.filter((e) => e.kind === 'dispatch').reduce<Said | null>((latest, e) => (!latest || e.at > latest.at ? e : latest), null)
  if (!dispatch) return null
  try {
    const { worker, agent, model } = JSON.parse(dispatch.body) as Record<string, unknown>
    const word = (v: unknown) => (typeof v === 'string' && v ? v : null)
    return word(worker) ? { name: word(worker)!, agent: word(agent), model: word(model) } : null
  } catch {
    return null
  }
}

export const ALL_PROJECTS = '全部项目'
export const projectChoices = (names: string[], withAll: boolean) => (withAll ? [ALL_PROJECTS, ...names] : names)
export const inScope = (items: Waiting[], scope: string) => (scope === ALL_PROJECTS ? items : items.filter((i) => i.project === scope))
export const waitingKey = (w: Pick<Waiting, 'project' | 'id'>) => w.project + '/' + w.id
