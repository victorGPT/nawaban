import { foldKey, localMonthDayTime, sinceLabel, taskSections, WINDOW_WORDS } from '../../herdr/mods/nawaban-board/logic.js'

export { foldKey, localMonthDayTime, sinceLabel, taskSections, WINDOW_WORDS }

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
export type BoardTask = {
  id: string
  title: string
  status: 'open' | 'in_progress' | 'done'
  parent: string | null
  session: string | null
  active_at: number
  claimed_at: number | null
  done_at?: number | null
  progress?: Progress
  waiting?: string | null
  pending?: unknown
  blocked_by?: string[]
}
export type Board = { columns: { key: string; tasks: BoardTask[] }[]; decisions: unknown[] }
export type Project = { name: string; open: number; total: number; waiting: number }

export type ItemState = 'done' | 'stopped' | 'working' | 'todo'
export type Item = { key: string; id: string; title: string; state: ItemState; at: number | null; note: string | null; spec: { done: number; total: number } | null }
export type Group = 'stopped' | 'working' | 'todo' | 'done'

const HOUR = 3600
export const STOPPED_AFTER_SILENT_FOR = 24 * HOUR
const GROUPS: Group[] = ['stopped', 'working', 'todo', 'done']

export function stateOf(t: BoardTask, now: number): ItemState {
  if (t.status === 'done') return 'done'
  if (t.waiting) return 'stopped'
  if (!t.session) return 'todo'
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

function itemOf(root: BoardTask, tickets: BoardTask[], now: number) {
  const states = tickets.map((t) => stateOf(t, now))
  const lead = tickets[states.indexOf('stopped')] ?? tickets[states.indexOf('working')] ?? root
  const allTicketsDone = tickets.length > 0 && states.every((s) => s === 'done')
  const state: ItemState = root.status === 'done' || allTicketsDone ? 'done' : stateOf(lead, now)
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
    spec: tickets.length ? { done: states.filter((s) => s === 'done').length, total: tickets.length } : null,
    active: Math.max(...[root, ...tickets].map((t) => t.active_at ?? 0)),
  }
}

const GROUP_OF: Record<ItemState, Group> = { stopped: 'stopped', working: 'working', todo: 'todo', done: 'done' }

export function taskGroups(board: Board | null, now: number): { group: Group; items: Item[] }[] {
  const tasks = allOf(board)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const roots = tasks.filter((t) => rootOf(t, byId) === t)
  const items = roots.map((root) => itemOf(root, tasks.filter((t) => t !== root && rootOf(t, byId) === root), now))
  return GROUPS.map((group) => ({
    group,
    items: items
      .filter((x) => GROUP_OF[x.state] === group)
      .sort(group === 'done' ? (x, y) => (y.at ?? 0) - (x.at ?? 0) : (x, y) => y.active - x.active)
      .map(({ active, ...x }) => x),
  })).filter((g) => g.items.length)
}

export function summaryOf(groups: { group: Group; items: Item[] }[], pending: number) {
  const count = (g: Group) => groups.find((x) => x.group === g)?.items.length ?? 0
  const w = WINDOW_WORDS.zh.groups
  return [pending ? `待决 ${pending}` : null, `${w.working} ${count('working')}`, `${w.stopped} ${count('stopped')}`, `${w.todo} ${count('todo')}`]
    .filter(Boolean)
    .join(' · ')
}

export const pendingCount = (board: Board | null) => allOf(board).filter((t) => t.status !== 'done' && t.pending).length

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
