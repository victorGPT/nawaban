import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { board, BoardEventView, MessageView } from '@vercel/board'
import { Refused } from './tasks.ts'

/**
 * `nawaban json projects|db|board|task`: the board as the Herdr panel reads it, in the shapes the old
 * nawaban/cli.py printed (projects_data, board_data, task_detail), so herdr/mods/nawaban-board reads
 * either. Times are seconds. A task's history (claims, completion) comes off the event feed, read once
 * from the oldest task on: docs/04-reference/03-http.md, "Event feed", `after` a message ID.
 */
type Team = ReturnType<typeof board>
type Task = NonNullable<MessageView['task']>

const DONE_LIMIT = 12 // the done column shows only the latest few
const DONE_RECENT = 24 * 3600 // ...plus every task done this recently
const DECISIONS_RECENT = 48 * 3600 // decisions: every one this recent, open task or closed
const PENDING_NOTES = 3 // a pending decision carries its task's last this many notes
// A hold the decision-maker answers: 等你 (needs_input) or a decision card (awaiting_approval).
const ASKS = new Set(['needs_input', 'awaiting_approval'])

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const key = (m: MessageView) => m.labels.key ?? `#${m.id}`
const title = (m: MessageView) => m.text.split('\n')[0]!
const body = (m: MessageView) => m.text.split('\n').slice(2).join('\n').trim()
/** An actor as the panel keys a window: its profile (`local:user:victor+cc-1a2b3c4d` is cc-1a2b3c4d), else its name. */
const who = (actor: string) => (actor.includes('+') ? actor.slice(actor.lastIndexOf('+') + 1) : actor.slice(actor.lastIndexOf(':') + 1))
const live = (t: Task | undefined) => (t?.claim && Date.parse(t.claim.until) > Date.now() ? t.claim : null)
const closed = (t: Task | undefined) => t?.state === 'completed' || t?.state === 'canceled' || t?.state === 'failed'
const data = (m: MessageView, name: string) =>
  m.blocks.find((b) => b.schema === name && b.data)?.data as Record<string, unknown> | undefined

/** Every task, all states, of one channel (undefined: every channel). */
async function tasksOf(team: Team, channel?: string) {
  const out: MessageView[] = []
  for (let after: string | undefined; ; ) {
    const page = await team.tasks.list({ channel, state: 'all', after, limit: 50 })
    out.push(...page.tasks.map((t) => t.message))
    if (page.tasks.length < 50) return out
    after = page.cursor
  }
}

type Reply = { message: MessageView; at: number; by: string }
type History = { replies: Reply[]; claims: { at: number; by: string }[]; done: number | null; active: number }

/**
 * What happened to each task: its replies, its claims, when it completed, its latest activity.
 * ponytail: reads the feed from the oldest task on, every read; a board with years of history would
 * want the views kept by a watcher instead.
 */
async function histories(team: Team, tasks: MessageView[], channel?: string) {
  const out = new Map<string, History>(tasks.map((t) => [t.id, { replies: [], claims: [], done: null, active: secs(t.createdAt) }]))
  if (!tasks.length) return out
  const seen = new Set<string>()
  let after = tasks.reduce((a, t) => (Number(t.id) < Number(a) ? t.id : a), tasks[0]!.id)
  for (;;) {
    const { events, cursor } = await team.poll({ channel, after })
    if (!events.length) return out
    after = cursor
    for (const e of events as BoardEventView[]) {
      const p = e.payload as { id?: string; by?: { actor: string } }
      const at = secs(e.createdAt)
      const m = e.message
      const thread = e.type === 'message.posted' ? m?.re : p.id
      const h = thread ? out.get(thread) : undefined
      if (!h) continue
      h.active = Math.max(h.active, at)
      if (e.type === 'message.posted' && m && !m.deleted && !seen.has(m.id)) {
        seen.add(m.id)
        h.replies.push({ message: m, at, by: who(p.by?.actor ?? '') })
      } else if (e.type === 'task.claimed') h.claims.push({ at, by: who(p.by!.actor) })
      else if (e.type === 'task.completed') h.done = at
    }
  }
}

const isNote = (r: Reply) => r.message.blocks.length === 0
const progress = (r: Reply | undefined) => (r ? { body: r.message.text, at: r.at } : null)

/** A task as board_data's row: who holds it, in which terminal, under which orchestrator, and what waits on the decision-maker. */
function row(m: MessageView, h: History, byId: Map<string, MessageView>) {
  const t = m.task!
  const claim = live(t)
  const ask = t.blocked && ASKS.has(t.blocked.kind ?? '') ? t.blocked : null
  const lastClaimer = h.claims.at(-1)?.by ?? null
  // A hold ends the claim; the window that asked still has the task, as needs-info left it held before.
  const session = claim ? who(claim.actor) : ask ? lastClaimer : null
  const done = t.state === 'completed'
  const notes = h.replies.filter(isNote)
  const latest = (name: string) => h.replies.findLast((r) => data(r.message, name))
  const dispatch = latest('nawaban-dispatch')
  const decision = latest('nawaban-decision')
  const card = latest('nawaban-ask')
  const open = (t.needs ?? []).filter((id) => byId.get(id)?.task?.state !== 'completed')
  const out = {
    id: key(m),
    title: title(m),
    status: done ? 'done' : session ? 'in_progress' : 'open',
    project: m.channel,
    parent: m.labels.parent ?? null,
    session,
    created_at: secs(m.createdAt),
    active_at: h.active,
    open_blockers: open.length,
    terminal: session ? (m.labels.terminal ?? null) : null,
    // GLOSSARY Orchestrator: the latest dispatch's author, else the holder, else the last claimer.
    leader: dispatch?.by ?? session ?? lastClaimer,
    claimed_at: h.claims[0]?.at ?? null,
  }
  if (done) return { ...out, done_at: h.done }
  return {
    ...out,
    progress: progress(notes.findLast((r) => !/^\s*(?:coord|impact):/.test(r.message.text))),
    blocked_by: open.map((id) => (byId.get(id) ? key(byId.get(id)!) : `#${id}`)).sort(),
    waiting: ask?.reason ?? null,
    decision: decision ? { at: decision.at, verdict: String(data(decision.message, 'nawaban-decision')!.verdict) } : null,
    pending:
      t.blocked?.kind === 'awaiting_approval'
        ? {
            brief: String(card ? data(card.message, 'nawaban-ask')!.decision : t.blocked.reason),
            at: card?.at ?? h.active,
            progress: notes.slice(-PENDING_NOTES).map(progress),
          }
        : null,
  }
}

/** Every task needed by one in `tasks` but outside it (another project's), so a blocker reads its real state. */
async function withNeeds(team: Team, tasks: MessageView[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const missing = [...new Set(tasks.flatMap((t) => t.task?.needs ?? []))].filter((id) => !byId.has(id))
  for (const m of await Promise.all(missing.map((id) => team.thread(id, { limit: 1 }).then((t) => t.message)))) byId.set(m.id, m)
  return byId
}

export async function boardData(team: Team, project?: string, now = Date.now() / 1000) {
  const tasks = (await tasksOf(team, project)).filter((m) => m.task && m.task.state !== 'canceled' && m.task.state !== 'failed')
  const [byId, hist] = await Promise.all([withNeeds(team, tasks), histories(team, tasks, project)])
  const byKey = new Map(tasks.map((t) => [key(t), t]))
  const rows = tasks
    .map((m) => ({ m, h: hist.get(m.id)! }))
    .sort((a, b) => b.h.active - a.h.active || (key(a.m) < key(b.m) ? -1 : 1))
  const columns: Record<string, unknown[]> = { open: [], in_progress: [], done: [] }
  for (const { m, h } of rows) {
    const r = row(m, h, byId)
    const parent = m.labels.parent ? byKey.get(m.labels.parent) : undefined
    // Past the latest few, done tasks stay only while recent or under an open spec (the panel ticks them).
    if (r.status === 'done' && columns.done!.length >= DONE_LIMIT && !(parent && !closed(parent.task)) && (h.done ?? 0) < now - DONE_RECENT) continue
    columns[r.status]!.push(r)
  }
  const decisions = rows
    .flatMap(({ m, h }) =>
      h.replies.flatMap((r) => {
        const d = data(r.message, 'nawaban-decision')
        return d && r.at >= now - DECISIONS_RECENT ? [{ task: key(m), at: r.at, verdict: String(d.verdict), owner: d.by === 'user' }] : []
      }),
    )
    .sort((a, b) => b.at - a.at)
  return { columns: Object.entries(columns).map(([k, v]) => ({ key: k, tasks: v })), decisions }
}

export async function projectsData(team: Team) {
  const counts = new Map<string, { name: string; open: number; total: number; waiting: number }>()
  for (const m of await tasksOf(team)) {
    const p = counts.get(m.channel) ?? { name: m.channel, open: 0, total: 0, waiting: 0 }
    p.total++
    if (!closed(m.task)) {
      p.open++
      if (ASKS.has(m.task?.blocked?.kind ?? '')) p.waiting++
    }
    counts.set(m.channel, p)
  }
  return { projects: [...counts.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) }
}

/** A reply's event body, as the old CLI wrote it: a note's text, a decision's lines, a link's `kind:ref`. */
function event(r: Reply) {
  const [b] = r.message.blocks
  const kind = b ? b.schema.replace(/^nawaban-/, '') : 'note'
  const d = (b?.data ?? {}) as Record<string, unknown>
  const text =
    kind === 'note'
      ? r.message.text
      : kind === 'decision'
        ? [`Question: ${d.question}`, `Verdict: ${d.verdict}`, ...((d.rejected as string[]) ?? []).map((x) => `Rejected: ${x}`)].join('\n')
        : kind === 'link'
          ? `${d.kind}:${d.ref}`
          : JSON.stringify(d)
  return { kind, body: text, author: d.by === 'user' ? 'user' : r.by, at: r.at }
}

export async function taskDetail(team: Team, ref: string) {
  const [m] = await team.tasks.list({ state: 'all', label: { key: ref } }).then((p) => p.tasks.map((t) => t.message))
  const task = m ?? (await team.thread(ref.replace(/^#/, ''), { limit: 1 }).then((t) => t.message, () => null))
  if (!task?.task) throw new Refused(`任务不存在:${ref}`)
  const all = await tasksOf(team)
  const byId = await withNeeds(team, all)
  const status = (x: MessageView) => (x.task!.state === 'completed' ? 'done' : x.task!.state === 'canceled' ? 'cancelled' : live(x.task) ? 'in_progress' : 'open')
  const ref_ = (x: MessageView) => ({ id: key(x), title: title(x), status: status(x) })
  const h = (await histories(team, [task], task.channel)).get(task.id)!
  const events = h.replies.map(event).reverse()
  const parent = all.find((x) => key(x) === task.labels.parent)
  return {
    id: key(task),
    title: title(task),
    body: body(task),
    status: status(task),
    project: task.channel,
    session: live(task.task) ? who(task.task.claim!.actor) : null,
    created_at: secs(task.createdAt),
    parent: parent ? ref_(parent) : null,
    children: all.filter((x) => x.labels.parent === key(task)).map(ref_),
    blocked_by: (task.task.needs ?? []).flatMap((id) => (byId.get(id) ? [ref_(byId.get(id)!)] : [])),
    dependents: all.filter((x) => x.task?.needs?.includes(task.id)).map(ref_),
    latest_note: events.find((e) => e.kind === 'note') ?? null,
    decisions: events.filter((e) => e.kind === 'decision'),
    links: events.filter((e) => e.kind === 'link'),
    events,
  }
}

/** `nawaban json projects|db|board|task`: the JSON on stdout; an error is {"error": ...} with exit 1 (2 for usage). */
export async function json(argv: string[], team: Team, dir: string): Promise<number> {
  let out
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: 'string' } } })
    const [what, id] = positionals
    if (what === 'db' && positionals.length === 1) out = { db: await realpath(join(dir, 'local.db')) }
    else if (what === 'projects' && positionals.length === 1) out = await projectsData(team)
    else if (what === 'board' && positionals.length === 1) out = await boardData(team, values.project)
    else if (what === 'task' && id && positionals.length === 2) out = await taskDetail(team, id)
    else throw new Refused('usage: nawaban json projects|db|board [--project <p>]|task <id>|okr [--repo <path>]', 2)
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as Error).message }) + '\n')
    return error instanceof Refused ? error.code : 1
  }
  process.stdout.write(JSON.stringify(out) + '\n')
  return 0
}
