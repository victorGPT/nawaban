import {
  closedToday, doingOf, flowLine, foldKey, localMonthDayTime, MILESTONE_WORDS, MILESTONES, OKR_WORDS, okrReadingOfFailure, okrView as panelOkrView, sinceLabel, taskSections, WHO_AND_WHEN_ALREADY_SHOWN, WINDOW_WORDS,
} from '../../herdr/mods/nawaban-board/logic.js'
import type { Pending } from './decide-logic'

export { foldKey, localMonthDayTime, MILESTONE_WORDS, MILESTONES, OKR_WORDS, okrReadingOfFailure, sinceLabel, taskSections, WHO_AND_WHEN_ALREADY_SHOWN, WINDOW_WORDS }

export type KrStatus = 'met' | 'missed' | 'unmeasurable' | 'undecided' | 'stale' | 'untested'
export type KrRow = { name: string; status: KrStatus; value: string; target: string; measured: boolean; gap: string | null; day: string | null; series: string | null; failure: string | null; interval: string | null }
export type ObjectiveRow = { name: string; met: number; total: number; standing: 'missed' | 'unsure' | 'met'; rulers: string | null; krs: KrRow[]; untestedKrs: KrRow[]; metKrs: KrRow[] }
export type OkrView = { met: number; total: number; measured: string | null; objectives: ObjectiveRow[] }
export const okrView = (okr: unknown): OkrView | null => panelOkrView(okr, 'zh')

export const TABS = ['decide', 'okr', 'tasks', 'inbox'] as const
export type Tab = (typeof TABS)[number]
export type Route = { tab: Tab; task: string | null }

const TOKEN_PART = 'k='
const TASK_PART = 'task-'
const OPENING_TAB: Tab = 'tasks'

export function routeOf(hash: string) {
  const parts = hash.replace(/^#/, '').split('&').filter(Boolean)
  const token = parts.find((p) => p.startsWith(TOKEN_PART))?.slice(TOKEN_PART.length) || null
  const where = parts.find((p) => !p.startsWith(TOKEN_PART)) ?? ''
  const task = where.startsWith(TASK_PART) ? decodeOrNull(where.slice(TASK_PART.length)) : null
  const tab: Tab = task ? 'tasks' : ((TABS as readonly string[]).includes(where) ? (where as Tab) : OPENING_TAB)
  return { route: { tab, task } as Route, token, hashWithoutToken: where ? '#' + where : '' }
}

const decodeOrNull = (s: string) => {
  try {
    return decodeURIComponent(s) || null
  } catch {
    return null
  }
}

export const taskHref = (key: string) => '#' + TASK_PART + encodeURIComponent(key)

export type Progress = { body: string; at: number } | null
export type Live = { milestone: 'started' | 'edited' | 'committed' | 'pr' | 'review' | 'reported'; at: number } | null
export type Ruling = { at: number; verdict: string } | null
export type Doing = { head: string; chain: string | null; stale: boolean }
export type BoardTask = {
  id: string
  title: string
  status: 'open' | 'in_progress' | 'done'
  parent: string | null
  session: string | null
  terminal?: string | null
  active_at: number
  claimed_at: number | null
  done_at?: number | null
  progress?: Progress
  live?: Live
  ruling?: Ruling
  waiting?: string | null
  pending?: Pending | null
  blocked_by?: string[]
}
export type Board = { tracker?: 'github'; columns: { key: string; tasks: BoardTask[] }[]; decisions: unknown[] }
export type Project = { name: string; open: number; total: number; waiting: number }

export type ItemState = 'done' | 'stopped' | 'working' | 'todo'
export type Item = { key: string; id: string; title: string; state: ItemState; at: number | null; note: string | null; doing: Doing | null; spec: { done: number; total: number } | null; waiting: boolean; parent: string | null }
export type Group = 'stopped' | 'working' | 'todo' | 'done'

const HOUR = 3600
export const STOPPED_AFTER_SILENT_FOR = 24 * HOUR
const GROUPS: Group[] = ['stopped', 'working', 'todo', 'done']

const heldOnGithubByAClaimTerminalAsInThePanel = (t: BoardTask, github: boolean) => github && !!t.terminal

export function stateOf(t: BoardTask, now: number, github = false): ItemState {
  if (t.status === 'done') return 'done'
  if (t.waiting) return 'stopped'
  if (!t.session && !heldOnGithubByAClaimTerminalAsInThePanel(t, github)) return 'todo'
  return now - t.active_at > STOPPED_AFTER_SILENT_FOR ? 'stopped' : 'working'
}

const allOf = (board: Board | null) => (board?.columns ?? []).flatMap((c) => c.tasks ?? [])

function rootOf(t: BoardTask, byId: Map<string, BoardTask>) {
  const seen = new Set<string>()
  while (t.parent && byId.has(t.parent) && !seen.has(t.id)) {
    seen.add(t.id)
    t = byId.get(t.parent)!
  }
  return t
}

function itemOf(root: BoardTask, tickets: BoardTask[], byId: Map<string, BoardTask>, now: number, github: boolean) {
  const states = tickets.map((t) => stateOf(t, now, github))
  const lead = tickets[states.indexOf('stopped')] ?? tickets[states.indexOf('working')] ?? root
  const allTicketsDone = tickets.length > 0 && states.every((s) => s === 'done')
  const state: ItemState = root.status === 'done' || allTicketsDone ? 'done' : stateOf(lead, now, github)
  const at =
    state === 'done'
      ? (root.done_at ?? Math.max(0, ...tickets.map((t) => t.done_at ?? 0)))
      : state === 'working'
        ? lead.claimed_at
        : state === 'stopped'
          ? lead.active_at
          : null
  const held = state === 'working' || state === 'stopped'
  return {
    key: 'task:' + root.id,
    id: root.id,
    title: root.title,
    state,
    at,
    note: held ? (lead.waiting ?? lead.progress?.body ?? null) : null,
    doing: held ? (doingOf(lead, byId, root.title, undefined, now) as Doing) : null,
    spec: tickets.length ? { done: states.filter((s) => s === 'done').length, total: tickets.length } : null,
    waiting: state === 'stopped' && !!lead.waiting,
    parent: (root.parent && byId.get(root.parent)?.title) || null,
    active: Math.max(...[root, ...tickets].map((t) => t.active_at ?? 0)),
  }
}

const GROUP_OF: Record<ItemState, Group> = { stopped: 'stopped', working: 'working', todo: 'todo', done: 'done' }

export function taskGroups(board: Board | null, now: number): { group: Group; items: Item[] }[] {
  const tasks = allOf(board)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const eachIssueStandsAloneAsInThePanel = board?.tracker === 'github'
  const roots = eachIssueStandsAloneAsInThePanel ? tasks : tasks.filter((t) => rootOf(t, byId) === t)
  const ticketsUnder = (root: BoardTask) => (eachIssueStandsAloneAsInThePanel ? [] : tasks.filter((t) => t !== root && rootOf(t, byId) === root))
  const items = roots.map((root) => itemOf(root, ticketsUnder(root), byId, now, eachIssueStandsAloneAsInThePanel))
  return GROUPS.map((group) => ({
    group,
    items: items
      .filter((x) => GROUP_OF[x.state] === group)
      .sort(group === 'done' ? (x, y) => (y.at ?? 0) - (x.at ?? 0) : (x, y) => y.active - x.active)
      .map(({ active, ...x }) => x),
  })).filter((g) => g.items.length)
}

export const BOARD_COLUMNS: Group[] = ['todo', 'working', 'stopped', 'done']
export const DONE_SHOWN_ON_BOARD = 10
const longestStoppedFirst = (x: Item, y: Item) => (x.at ?? 0) - (y.at ?? 0)

export function boardColumns(groups: { group: Group; items: Item[] }[], doneShownAll: boolean) {
  return BOARD_COLUMNS.map((group) => {
    const items = groups.find((g) => g.group === group)?.items ?? []
    const ordered = group === 'stopped' ? [...items].sort(longestStoppedFirst) : items
    const capped = group === 'done' && ordered.length > DONE_SHOWN_ON_BOARD
    const shown = capped && !doneShownAll ? ordered.slice(0, DONE_SHOWN_ON_BOARD) : ordered
    return { group, count: items.length, items: shown, more: capped ? { hidden: ordered.length - shown.length } : null }
  })
}

export function cardSignal(item: Item, now: number): string | null {
  if (item.waiting) return WINDOW_WORDS.zh.waiting
  if (item.state !== 'stopped') return null
  return item.at == null ? WINDOW_WORDS.zh.stopped : '停了 ' + sinceLabel(item, now, 'zh')
}

export const boardTaskOf = (board: Board | null, id: string | null) => allOf(board).find((t) => t.id === id) ?? null

export const waitingOnYouCount = (board: Board | null) => allOf(board).filter((t) => t.status !== 'done' && (t.pending || t.waiting)).length

export const summaryOf = (board: Board | null, now: number): string =>
  board ? flowLine({ closed: closedToday(board, now), running: taskGroups(board, now).find((g) => g.group === 'working')?.items.length ?? 0, waiting: waitingOnYouCount(board) }) : ''

export function projectShown(projects: Project[], picked: string | null) {
  if (picked && projects.some((p) => p.name === picked)) return picked
  return [...projects].sort((a, b) => b.open - a.open || (a.name < b.name ? -1 : 1))[0]?.name ?? null
}

const SAFE_LINK = /^https?:\/\//
export function linkOf(body: string) {
  const at = body.indexOf(':')
  const kind = at > 0 ? body.slice(0, at) : ''
  const ref = at > 0 ? body.slice(at + 1) : body
  return { kind, ref, href: SAFE_LINK.test(ref) ? ref : null }
}

const STRUCTURED_TARGET = /^([≥≤<>=])\s*(-?\d+(?:\.\d+)?)/
const LOWER_IS_BETTER = new Set(['≤', '<'])

export function krFill(k: { measured: boolean; target: string | null; value: string }) {
  const goal = STRUCTURED_TARGET.exec(String(k.target ?? ''))
  const value = parseFloat(k.value)
  if (!k.measured || !goal || !Number.isFinite(value)) return null
  const target = Number(goal[2])
  const fill = LOWER_IS_BETTER.has(goal[1]!) ? (value <= target ? 1 : target / value) : target > 0 ? value / target : value >= target ? 1 : 0
  return Math.min(1, Math.max(0, fill))
}
