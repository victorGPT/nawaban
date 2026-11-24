import { linkOf, MILESTONE_WORDS, MILESTONES, stateOf, type BoardTask, type ItemState } from './logic'
import { markdownHtml } from './markdown'

export type Ref = { id: string; title: string; status: string }
export type Event = { kind: string; body: string; author: string; at: number }
export type Detail = {
  id: string; title: string; body: string; status: string; project: string; session: string | null; created_at: number
  parent: Ref | null; children: Ref[]; blocked_by: Ref[]; dependents: Ref[]
  latest_note: Event | null; decisions: Event[]; links: Event[]; events: Event[]
}

export type By = 'owner' | 'agent'
export type Entry = { at: number; line: string; full: string }
export type Ruling = Entry & { by: By; question: string | null }
export type Row =
  | ({ kind: 'decision'; by: By; question: string | null } & Entry)
  | ({ kind: 'ask' } & Entry)
  | ({ kind: 'note' } & Entry)
  | { kind: 'notes'; at: number; line: string; notes: Entry[] }
  | { kind: 'milestone'; at: number; line: string; href: string | null; mark: 'dispatch' | 'pr' | 'done' }
export type Day = { key: string; label: string; rows: Row[] }
export type Step = { word: string; status: 'completed' | 'in_progress' | 'pending' }
export type Section = { label: string | null; html: string }
export type DetailView = {
  state: ItemState
  steps: Step[] | null
  movedAt: number | null
  waiting: string | null
  ruling: Ruling | null
  sections: Section[]
  days: Day[]
  links: { label: string; href: string | null }[]
}

const OWNER_AUTHOR = 'user'
const ASK_OPENING = 'triage: needs-info — 等你：'
const SAYING_PREFIX = /^(?:决定|进展|已完成)：/
const QUESTION_LINE = /^背景：(.*)$/m
const PR_NUMBER = /\/pull\/(\d+)/
const SHORT_SHA = 7
const SECTION_HEAD = /^##\s+(.+)$/
const SECTION_NAMES: Record<string, string> = { 'What to build': '做什么', 'Acceptance criteria': '完成标准' }
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const MS_PER_SECOND = 1000
const HELD: ItemState[] = ['working', 'stopped']

const byOf = (e: Event): By => (e.author === OWNER_AUTHOR ? 'owner' : 'agent')
const firstLine = (text: string) => text.trim().split('\n')[0]!.trim()
const entryOf = (at: number, text: string): Entry => {
  const full = text.trim().replace(SAYING_PREFIX, '')
  return { at, line: firstLine(full), full }
}
const questionOf = (body: string) => QUESTION_LINE.exec(body)?.[1]?.trim() || null

const workerOf = (body: string): string => {
  try {
    return String(JSON.parse(body)?.worker ?? '')
  } catch {
    return ''
  }
}

function linkLabel(body: string) {
  const link = linkOf(body)
  if (link.kind === 'pr') return { label: 'PR' + (PR_NUMBER.exec(link.ref) ? ' #' + PR_NUMBER.exec(link.ref)![1] : ''), href: link.href }
  if (link.kind === 'commit') return { label: link.ref.slice(0, SHORT_SHA), href: link.href }
  return { label: link.kind || link.ref, href: link.href }
}

const ROW_OF_EVENT: Record<string, (e: Event) => Row | null> = {
  decision: (e) => ({ kind: 'decision', by: byOf(e), question: questionOf(e.body), ...entryOf(e.at, e.body) }),
  note: (e) =>
    e.body.startsWith(ASK_OPENING)
      ? { kind: 'ask', at: e.at, line: firstLine(e.body.slice(ASK_OPENING.length)), full: e.body.trim() }
      : { kind: 'note', ...entryOf(e.at, e.body) },
  dispatch: (e) => ({ kind: 'milestone', at: e.at, line: ['派工', workerOf(e.body)].filter(Boolean).join(' '), href: null, mark: 'dispatch' }),
  link: (e) => (linkOf(e.body).kind === 'pr' ? { kind: 'milestone', at: e.at, line: '开 ' + linkLabel(e.body).label, href: linkLabel(e.body).href, mark: 'pr' } : null),
}

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (at: number) => new Date(at * MS_PER_SECOND)
const dayKeyOf = (d: Date) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const dayKey = (at: number) => dayKeyOf(localDate(at))
export const clockOf = (at: number) => {
  const d = localDate(at)
  return pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function dayLabel(at: number, now: number) {
  const d = localDate(at)
  const today = localDate(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (dayKeyOf(d) === dayKeyOf(today)) return '今天'
  if (dayKeyOf(d) === dayKeyOf(yesterday)) return '昨天'
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + WEEKDAYS[d.getDay()]
}

const oldestFirst = (events: Event[]) => [...events].reverse().sort((a, b) => a.at - b.at)

function foldedProgress(rows: Row[]): Row[] {
  const folded: Row[] = []
  let run: Entry[] = []
  const closeRun = () => {
    if (run.length === 1) folded.push({ kind: 'note', ...run[0]! })
    if (run.length > 1) folded.push({ kind: 'notes', at: run.at(-1)!.at, line: run.at(-1)!.line, notes: [...run].reverse() })
    run = []
  }
  for (const row of rows) {
    if (run.length && dayKey(run[0]!.at) !== dayKey(row.at)) closeRun()
    if (row.kind === 'note') run.push({ at: row.at, line: row.line, full: row.full })
    else {
      closeRun()
      folded.push(row)
    }
  }
  closeRun()
  return folded
}

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

export function detailView(detail: Detail, boardTask: BoardTask | null, now: number): DetailView {
  const state: ItemState = boardTask ? stateOf(boardTask, now) : detail.status === 'done' ? 'done' : 'todo'
  const said = oldestFirst(detail.events).map((e) => ROW_OF_EVENT[e.kind]?.(e) ?? null).filter((r): r is Row => r !== null)
  const finished: Row[] = boardTask?.done_at ? [{ kind: 'milestone', at: boardTask.done_at, line: '完成', href: null, mark: 'done' }] : []
  const rows = foldedProgress([...said, ...finished].sort((a, b) => a.at - b.at))
  const latestDecision = said.filter((r) => r.kind === 'decision').at(-1)
  return {
    state,
    steps: boardTask && HELD.includes(state) ? stepsAt(boardTask.live?.milestone ?? 'started') : null,
    movedAt: boardTask ? (boardTask.live?.at ?? boardTask.active_at) : null,
    waiting: boardTask?.waiting || null,
    ruling: latestDecision ? { at: latestDecision.at, line: latestDecision.line, full: latestDecision.full, by: latestDecision.by, question: latestDecision.question } : null,
    sections: sectionsOf(detail.body ?? ''),
    days: daysOf(rows, now),
    links: detail.links.map((e) => linkLabel(e.body)),
  }
}

export function daysUpTo(days: Day[], limit: number) {
  const shown: Day[] = []
  let room = limit
  for (const day of days) {
    if (room <= 0) break
    shown.push({ ...day, rows: day.rows.slice(0, room) })
    room -= day.rows.length
  }
  const total = days.reduce((n, d) => n + d.rows.length, 0)
  return { days: shown, hidden: Math.max(0, total - limit) }
}
