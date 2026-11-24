import { linkOf, MILESTONE_WORDS, MILESTONES, sinceLabel, stateOf, WHO_AND_WHEN_ALREADY_SHOWN, WINDOW_WORDS, type BoardTask, type ItemState } from './logic'
import { markdownHtml } from './markdown'

export type Ref = { id: string; title: string; status: string }
export type Event = { kind: string; body: string; author: string; at: number }
export type Detail = {
  id: string; title: string; body: string; status: string; project: string; session: string | null; created_at: number
  parent: Ref | null; children: Ref[]; blocked_by: Ref[]; dependents: Ref[]
  latest_note: Event | null; decisions: Event[]; links: Event[]; events: Event[]
  pulls?: Record<string, PullState>
}
export type PullState = 'merged' | 'closed' | 'ci_failed' | 'open'

export type By = 'owner' | 'agent'
export type Entry = { at: number; line: string; full: string }
export type Ruling = Entry & { by: By; question: string | null }
export type Row =
  | ({ kind: 'decision'; by: By; question: string | null } & Entry)
  | ({ kind: 'ask' } & Entry)
  | ({ kind: 'note' } & Entry)
  | ({ kind: 'dispatch' } & Entry)
export type Day = { key: string; label: string; rows: Row[] }
export type Step = { word: string; status: 'completed' | 'in_progress' | 'pending' }
export type Timeline = { forTheOwner: Day[]; everything: Day[]; total: number }
export type Holder = { name: string; runs: string | null; terminal: string | null }
export type Output = { label: string; note: string | null; href: string | null }
export type Facts = {
  stateWord: string
  cancelled: boolean
  holder: Holder | null
  dispatchedAt: number | null
  dispatcher: string | null
  lane: string | null
  goal: string | null
  parent: Ref | null
  children: Ref[]
  blockedBy: Ref[]
  dependents: Ref[]
  outputs: Output[]
  createdAt: number
  took: string | null
}
export type Section = { label: string | null; html: string }
export type Part = string | { label: string; href: string }
export type Link = { kind: string; ref: string; label: string; href: string | null }
export type DetailView = {
  state: ItemState
  headline: Part[]
  steps: Step[] | null
  stepLine: string | null
  waiting: string | null
  ruling: Ruling | null
  sections: Section[]
  timeline: Timeline
  facts: Facts
}

const OWNER_AUTHOR = 'user'
const ASK_OPENING = 'triage: needs-info — 等你：'
const SAYING_PREFIX = /^(?:决定|进展|已完成)：/
const BOOKKEEPING_NOTE = /^(?:lane|coord):/
const QUESTION_LINE = /^背景：(.*)$/m
const PR_NUMBER = /\/pull\/(\d+)/
const URL = /https?:\/\/[^\s（）()「」，。；]+/g
const SHORT_SHA = 7
const SECTION_HEAD = /^##\s+(.+)$/
const SECTION_NAMES: Record<string, string> = { 'What to build': '做什么', 'Acceptance criteria': '完成标准' }
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const MS_PER_SECOND = 1000
const HELD: ItemState[] = ['working', 'stopped']
const MINUTE = 60
const W = WINDOW_WORDS.zh

const byOf = (e: Event): By => (e.author === OWNER_AUTHOR ? 'owner' : 'agent')
const placeOf = (url: string) => (PR_NUMBER.exec(url) ? 'PR #' + PR_NUMBER.exec(url)![1] : url.replace(/^https?:\/\//, '').split('/')[0]!)
const withPlacesForUrls = (text: string) => text.replace(URL, placeOf)
const OPENS_WHAT_FOLLOWS = /[：:]$/
const DECISION_FIELD = /^(?:背景|否决方案)：/
function firstLine(text: string) {
  const [first = '', ...rest] = text.trim().split('\n').map((l) => l.trim()).filter((l) => l && !DECISION_FIELD.test(l))
  return withPlacesForUrls(OPENS_WHAT_FOLLOWS.test(first) && rest.length ? first + rest[0] : first)
}
const entryOf = (at: number, text: string): Entry => {
  const full = text.trim().replace(SAYING_PREFIX, '')
  return { at, line: firstLine(full), full }
}
const questionOf = (body: string) => QUESTION_LINE.exec(body)?.[1]?.trim() || null

const dataOf = (body: string): Record<string, unknown> => {
  try {
    return Object(JSON.parse(body))
  } catch {
    return {}
  }
}
const wordOf = (value: unknown) => (typeof value === 'string' && value ? value : null)
const CLAUDE_GOES_BY_ITS_MODEL = 'claude'
function dispatchOf(body: string) {
  const { worker, orchestrator, agent, model } = dataOf(body)
  const runs = [wordOf(agent) === CLAUDE_GOES_BY_ITS_MODEL && wordOf(model) ? null : wordOf(agent), wordOf(model)].filter(Boolean).join(' ')
  return { worker: wordOf(worker), orchestrator: wordOf(orchestrator), runs: runs || null }
}

type CardOption = { choice?: string; tradeoff?: string }
function cardOf(body: string) {
  const card = dataOf(body)
  const options = (Array.isArray(card.options) ? (card.options as CardOption[]) : []).map((o) => [o.choice, o.tradeoff].filter(Boolean).join('｜'))
  return [card.decision, card.context, ...options, card.recommendation && '建议：' + card.recommendation].filter(Boolean).join('\n')
}

function linkLabel(body: string): Link {
  const { kind, ref: said } = linkOf(body)
  const ref = said.trim().split(/\s+/)[0]!
  const href = linkOf(kind + ':' + ref).href
  if (kind === 'pr') return { kind, ref, label: 'PR' + (PR_NUMBER.exec(ref) ? ' #' + PR_NUMBER.exec(ref)![1] : ''), href }
  if (kind === 'commit') return { kind, ref, label: ref.slice(0, SHORT_SHA), href }
  return { kind, ref, label: kind || ref, href }
}

function partsOf(text: string): Part[] {
  const parts: Part[] = []
  let from = 0
  for (const url of text.matchAll(URL)) {
    parts.push(text.slice(from, url.index), { label: placeOf(url[0]), href: url[0] })
    from = url.index + url[0].length
  }
  return [...parts, text.slice(from)].filter((p) => p !== '')
}

const ROW_OF_EVENT: Record<string, (e: Event) => Row | null> = {
  decision: (e) => {
    const told = byOf(e) === 'owner' ? e.body.replace(SAYING_PREFIX, '').replace(WHO_AND_WHEN_ALREADY_SHOWN, '') : e.body
    return { kind: 'decision', by: byOf(e), question: questionOf(e.body), ...entryOf(e.at, told) }
  },
  note: (e) =>
    BOOKKEEPING_NOTE.test(e.body)
      ? null
      : e.body.startsWith(ASK_OPENING)
      ? { kind: 'ask', at: e.at, line: firstLine(e.body.slice(ASK_OPENING.length)), full: e.body.slice(ASK_OPENING.length).trim() }
      : { kind: 'note', ...entryOf(e.at, e.body) },
  ask: (e) => ({ kind: 'ask', ...entryOf(e.at, cardOf(e.body) || e.body) }),
  resolve: (e) => ({ kind: 'decision', by: 'owner', question: null, ...entryOf(e.at, String(dataOf(e.body).words ?? e.body)) }),
  dispatch: (e) => {
    const { worker, terminal, accept } = dataOf(e.body)
    return { kind: 'dispatch', ...entryOf(e.at, [['派工', worker, terminal].filter(Boolean).join(' '), accept && '验收：' + accept].filter(Boolean).join('\n')) }
  },
}

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (at: number) => new Date(at * MS_PER_SECOND)
const dayKeyOf = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const dayKey = (at: number) => dayKeyOf(localDate(at))
export const clockOf = (at: number) => {
  const d = localDate(at)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export const stampOf = (at: number) => pad(localDate(at).getMonth() + 1) + '/' + pad(localDate(at).getDate()) + ' ' + clockOf(at)

function dayLabel(at: number, now: number) {
  const d = localDate(at)
  const today = localDate(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKeyOf(d) === dayKeyOf(today)) return '今天'
  if (dayKeyOf(d) === dayKeyOf(yesterday)) return '昨天'
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + WEEKDAYS[d.getDay()]
}

const oldestFirst = (events: Event[]) => [...events].reverse().sort((a, b) => a.at - b.at)

const isForTheOwner = (row: Row) => row.kind === 'ask' || (row.kind === 'decision' && row.by === 'owner')

function daysOf(rows: Row[], now: number): Day[] {
  const days: Day[] = []
  for (const row of [...rows].reverse()) {
    const key = dayKey(row.at)
    if (days.at(-1)?.key !== key) days.push({ key, label: dayLabel(row.at, now), rows: [] })
    days.at(-1)!.rows.push(row)
  }
  return days
}

function sectionsOf(body: string): Section[] {
  const parts: { label: string | null; lines: string[] }[] = [{ label: null, lines: [] }]
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const head = SECTION_HEAD.exec(line)
    if (head) parts.push({ label: SECTION_NAMES[head[1]!.trim()] ?? head[1]!.trim(), lines: [] })
    else parts.at(-1)!.lines.push(line)
  }
  return parts.filter((p) => p.lines.join('').trim()).map((p) => ({ label: p.label, html: markdownHtml(p.lines.join('\n').trim()) }))
}

function stepsAt(reached: string): Step[] {
  const at = Math.max(0, MILESTONES.indexOf(reached))
  return MILESTONES.map((m, i) => ({
    word: MILESTONE_WORDS[m as keyof typeof MILESTONE_WORDS],
    status: i < at ? 'completed' : i === at ? 'in_progress' : 'pending',
  }))
}

const quietFor = (task: BoardTask, now: number) => {
  const moved = task.live?.at ?? task.active_at
  return now - moved < MINUTE ? null : sinceLabel({ state: 'working', at: moved }, now, 'zh')
}
const joined = (...words: (string | null)[]) => words.filter(Boolean).join(' · ')

const HEADLINE_OF: Record<ItemState, (task: BoardTask, seen: { steps: Step[] | null; pr: Link | undefined; now: number }) => Part[]> = {
  todo: () => [],
  working: () => [],
  stopped: (task, { now }) => (task.waiting ? partsOf(task.waiting.trim().split('\n')[0]!) : [joined(W.stopped, quietFor(task, now) && quietFor(task, now) + '没动')]),
  done: (task, { pr }) => [joined(W.done, task.done_at ? stampOf(task.done_at) : null), ...(pr?.href ? [' · ', { label: pr.label, href: pr.href }] : [])],
}

const LANE_NOTE = /^lane:\s*(\S.*)$/
const MERGED_MARK = /\smerged\b/
const ADR_NUMBER = /\d{3,}/
const NO_OBJECTIVE = '无'
const CLOSED = new Set(['done', 'cancelled'])

const STATE_WORDS: Record<ItemState, (waiting: boolean) => string> = {
  todo: () => W.todo,
  working: () => W.pushing,
  stopped: (waiting) => (waiting ? W.waiting : '卡住'),
  done: () => '完成',
}

const PULL_WORDS: Record<PullState, string> = { merged: '已合并', closed: '已关闭', ci_failed: 'CI 红', open: '开着' }

const OUTPUT_OF: Record<string, (link: Link, pull: PullState | null) => Output> = {
  pr: (link, pull) => ({ label: link.label, note: pull ? PULL_WORDS[pull] : null, href: link.href }),
  artifact: (link) => ({ label: '设计稿', note: null, href: link.href }),
  adr: (link) => ({ label: 'ADR ' + (ADR_NUMBER.exec(link.ref)?.[0] ?? link.ref), note: null, href: link.href }),
  commit: (link) => ({ label: '提交 ' + link.label, note: null, href: link.href }),
}

function outputsOf(links: Event[], pulls: Record<string, PullState>): Output[] {
  const mergedPrs = new Set(links.filter((e) => MERGED_MARK.test(e.body)).map((e) => linkLabel(e.body).ref))
  const pullOf = (ref: string) => (Object.hasOwn(pulls, ref) ? pulls[ref]! : mergedPrs.has(ref) ? 'merged' : null)
  const outputs = links.map((e) => linkLabel(e.body)).map((link) => (Object.hasOwn(OUTPUT_OF, link.kind) ? OUTPUT_OF[link.kind]!(link, pullOf(link.ref)) : { label: link.label, note: null, href: link.href }))
  return outputs.filter((o, i) => outputs.findIndex((x) => x.label === o.label && x.href === o.href) === i)
}

function goalOf(events: Event[]) {
  const impact = dataOf(events.filter((e) => e.kind === 'impact').at(-1)?.body ?? '')
  const krs = (Array.isArray(impact.krs) ? (impact.krs as ({ name?: string } | null)[]) : []).map((k) => k?.name).filter(Boolean)
  return impact.objective && impact.objective !== NO_OBJECTIVE ? [impact.objective, krs.join('、')].filter(Boolean).join(' / ') : null
}

function tookOf(state: ItemState, boardTask: BoardTask | null, dispatchedAt: number | null, now: number) {
  const started = boardTask?.claimed_at ?? dispatchedAt
  if (!boardTask || started == null) return null
  if (state === 'done') return boardTask.done_at ? '用时 ' + sinceLabel({ state: 'working', at: started }, boardTask.done_at, 'zh') : null
  return HELD.includes(state) ? '开工至今 ' + sinceLabel({ state: 'working', at: started }, now, 'zh') : null
}

export function detailView(detail: Detail, boardTask: BoardTask | null, now: number, github = false): DetailView {
  const state: ItemState = boardTask ? stateOf(boardTask, now, github) : detail.status === 'done' ? 'done' : 'todo'
  const said = oldestFirst(detail.events).map((e) => (Object.hasOwn(ROW_OF_EVENT, e.kind) ? ROW_OF_EVENT[e.kind]!(e) : null)).filter((r): r is Row => r !== null)
  const events = oldestFirst(detail.events)
  const dispatches = events.filter((e) => e.kind === 'dispatch')
  const dispatchedAt = dispatches.at(-1)?.at ?? null
  const cancelled = detail.status === 'cancelled'
  const lastDispatch = dispatches.length ? dispatchOf(dispatches.at(-1)!.body) : null
  const lastWorker = dispatches.map((e) => dispatchOf(e.body).worker).filter(Boolean).at(-1)
  const latestDecision = said.filter((r) => r.kind === 'decision').at(-1)
  const steps = boardTask && HELD.includes(state) ? stepsAt(boardTask.live?.milestone ?? 'started') : null
  const links = detail.links.map((e) => linkLabel(e.body))
  return {
    state,
    headline: boardTask ? HEADLINE_OF[state](boardTask, { steps, pr: links.find((l) => l.kind === 'pr'), now }) : state === 'done' ? [W.done] : [],
    steps,
    stepLine: boardTask && steps ? joined(steps.find((s) => s.status === 'in_progress')!.word, quietFor(boardTask, now) && quietFor(boardTask, now) + '前') : null,
    waiting: boardTask?.waiting ? firstLine(boardTask.waiting) : null,
    ruling: latestDecision ? { at: latestDecision.at, line: latestDecision.line, full: latestDecision.full, by: latestDecision.by, question: latestDecision.question } : null,
    sections: sectionsOf(detail.body ?? ''),
    timeline: { forTheOwner: daysOf(said.filter(isForTheOwner), now), everything: daysOf(said, now), total: said.length },
    facts: {
      stateWord: cancelled ? '取消' : STATE_WORDS[state](!!boardTask?.waiting),
      cancelled,
      holder: boardTask?.session && (lastWorker ?? boardTask.terminal) ? { name: (lastWorker ?? boardTask.terminal)!, runs: lastWorker && lastWorker === lastDispatch?.worker ? lastDispatch.runs : null, terminal: lastWorker ? (boardTask.terminal ?? null) : null } : null,
      dispatchedAt,
      dispatcher: lastDispatch?.orchestrator ?? null,
      lane: events.map((e) => (e.kind === 'note' ? LANE_NOTE.exec(e.body.trim())?.[1]?.trim() : null)).filter(Boolean).at(-1) ?? null,
      goal: goalOf(events),
      parent: detail.parent,
      children: detail.children,
      blockedBy: detail.blocked_by.filter((r) => !CLOSED.has(r.status)),
      dependents: detail.dependents,
      outputs: outputsOf(events.filter((e) => e.kind === 'link'), detail.pulls ?? {}),
      createdAt: detail.created_at,
      took: tookOf(state, boardTask, dispatchedAt, now),
    },
  }
}
