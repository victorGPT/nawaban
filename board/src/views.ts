import { realpath } from 'node:fs/promises'
import { githubAskIn } from './github-tasks.ts'
import { syncStalledNote } from './github-sync-status.ts'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { board, BoardEventView, MessageView } from '@vercel/board'
import { narrationOf, type Hold } from './narrate.ts'
import { readLive } from './progress.ts'
import { noPullStates, type PullStateOf } from './pulls.ts'
import { gapsOfADecisionCard, type DecisionCard } from './schemas.ts'
import { Refused } from './tasks.ts'

type Team = ReturnType<typeof board>
type Task = NonNullable<MessageView['task']>

const HOUR = 3600
const DONE_ALWAYS_SHOWN_LATEST = 12
const DONE_ALSO_SHOWN_WITHIN = 24 * HOUR
const DECISIONS_SHOWN_WITHIN_OPEN_OR_CLOSED = 48 * HOUR
const NOTES_CARRIED_BY_A_PENDING_DECISION = 3
const PAGE = 50
const HOLDS_THE_DECISION_MAKER_ANSWERS = new Set(['needs_input', 'awaiting_approval'])
const EVENTS_THAT_END_A_CLAIM = new Set(['task.claimed', 'task.released', 'task.blocked', 'task.completed', 'task.canceled', 'task.failed', 'task.expired'])

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const key = (m: MessageView) => m.labels.key ?? `#${m.id}`
const title = (m: MessageView) => m.text.split('\n')[0]!
const body = (m: MessageView) => m.text.split('\n').slice(2).join('\n').trim()
const windowProfileElseName = (actor: string) => (actor.includes('+') ? actor.slice(actor.lastIndexOf('+') + 1) : actor.slice(actor.lastIndexOf(':') + 1))
const live = (t: Task | undefined) => (t?.claim && Date.parse(t.claim.until) > Date.now() ? t.claim : null)
const closed = (t: Task | undefined) => t?.state === 'completed' || t?.state === 'canceled' || t?.state === 'failed'
const data = (m: MessageView, name: string) =>
  m.blocks.find((b) => b.schema === name && b.data)?.data as Record<string, unknown> | undefined

export async function tasksOf(team: Team, channel?: string, state: 'all' | 'blocked' = 'all') {
  const out: MessageView[] = []
  for (let after: string | undefined; ; ) {
    const page = await team.tasks.list({ channel, state, after, limit: PAGE })
    out.push(...page.tasks.map((t) => t.message))
    if (page.tasks.length < PAGE) return out
    after = page.cursor
  }
}

type Reply = { message: MessageView; at: number; by: string }
type History = { replies: Reply[]; holds: Hold[]; done: number | null; active: number }

async function historiesFromTheFeedSinceTheOldestTask(team: Team, tasks: MessageView[], channel?: string) {
  const out = new Map<string, History>(tasks.map((t) => [t.id, { replies: [], holds: [], done: null, active: secs(t.createdAt) }]))
  if (!tasks.length) return out
  const seen = new Set<string>()
  let after = tasks.reduce((a, t) => (Number(t.id) < Number(a) ? t.id : a), tasks[0]!.id)
  for (;;) {
    const { events, cursor } = await team.poll({ channel, after })
    const feedEndsWhereTheCursorStaysNotAtAnEmptyPage = cursor === after
    if (feedEndsWhereTheCursorStaysNotAtAnEmptyPage) return out
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
        h.replies.push({ message: m, at, by: windowProfileElseName(p.by?.actor ?? '') })
      }
      const held = h.holds.at(-1)
      if (EVENTS_THAT_END_A_CLAIM.has(e.type) && held?.to === null) held.to = Date.parse(e.createdAt) / 1000
      if (e.type === 'task.claimed') h.holds.push({ by: windowProfileElseName(p.by!.actor), from: Date.parse(e.createdAt) / 1000, to: null })
      if (e.type === 'task.completed') h.done = at
    }
  }
}

function completeCardElseNull(ask: DecisionCard | undefined) {
  if (!ask || gapsOfADecisionCard(ask).length) return null
  return {
    decision: String(ask.decision),
    kr: String(ask.kr),
    context: String(ask.context),
    options: ask.options!.map((o, i) => ({ key: `第 ${i + 1} 项`, text: String(o.choice), note: [o.tradeoff, o.door].filter(Boolean).join('｜') })),
    rec: String(ask.recommendation),
  }
}

const orchestratorAsTheGlossaryDefinesIt = (latestDispatch: Reply | undefined, holder: string | null, lastClaimer: string | null) =>
  latestDispatch?.by ?? holder ?? lastClaimer

const GITHUB_PROGRESS_PREFIX = /^\s*(?:#{1,6}\s*)?\**进展\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]\**\s*/
const TRAILING_NAWABAN_MARKER = /\n*<!-- nawaban \{[^\n]*\} -->\s*$/
const fromGithub = (r: Reply) => r.message.from === 'github'
const visibleOnGithub = (r: Reply) => r.message.text.replace(TRAILING_NAWABAN_MARKER, '')
const isNote = (r: Reply) => r.message.blocks.length === 0 && (!fromGithub(r) || GITHUB_PROGRESS_PREFIX.test(visibleOnGithub(r)))
const progress = (r: Reply | undefined) => (r ? { body: fromGithub(r) ? visibleOnGithub(r).replace(GITHUB_PROGRESS_PREFIX, '') : r.message.text, at: r.at } : null)

function row(m: MessageView, h: History, byId: Map<string, MessageView>, dir: string | null) {
  const t = m.task!
  const claim = live(t)
  const ask = t.blocked && HOLDS_THE_DECISION_MAKER_ANSWERS.has(t.blocked.kind ?? '') ? t.blocked : null
  const lastClaimer = h.holds.at(-1)?.by ?? null
  const holderElseTheWindowThatAskedSinceAHoldEndsTheClaim = claim ? windowProfileElseName(claim.actor) : ask ? lastClaimer : null
  const session = holderElseTheWindowThatAskedSinceAHoldEndsTheClaim
  const done = t.state === 'completed'
  const notes = h.replies.filter(isNote)
  const latest = (name: string) => h.replies.findLast((r) => data(r.message, name))
  const dispatch = latest('nawaban-dispatch')
  const decision = latest('nawaban-decision')
  const ruling = h.replies.findLast((r) => data(r.message, 'nawaban-decision')?.by === 'user')
  const card = latest('nawaban-ask')
  const asked = h.replies.findLast((r) => data(r.message, 'nawaban-ask') || githubAskIn(r.message) !== null)
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
    leader: orchestratorAsTheGlossaryDefinesIt(dispatch, session, lastClaimer),
    claimed_at: h.holds[0] ? Math.floor(h.holds[0].from) : null,
  }
  if (done) return { ...out, done_at: h.done }
  return {
    ...out,
    live: session && dir ? readLive(dir, m.id) : null,
    ruling: ruling ? { at: ruling.at, verdict: String(data(ruling.message, 'nawaban-decision')!.verdict) } : null,
    progress: progress(notes.findLast((r) => !/^\s*(?:coord|impact|lane):/.test(r.message.text))),
    blocked_by: open.map((id) => (byId.get(id) ? key(byId.get(id)!) : `#${id}`)).sort(),
    waiting: ask?.reason ?? null,
    decision: decision ? { at: decision.at, verdict: String(data(decision.message, 'nawaban-decision')!.verdict) } : null,
    pending:
      t.blocked?.kind === 'awaiting_approval'
        ? {
            brief: String(asked && githubAskIn(asked.message) !== null ? githubAskIn(asked.message) : card ? data(card.message, 'nawaban-ask')!.decision : t.blocked.reason),
            at: asked?.at ?? h.active,
            progress: notes.slice(-NOTES_CARRIED_BY_A_PENDING_DECISION).map(progress),
            card: completeCardElseNull(card && data(card.message, 'nawaban-ask')),
            ask: asked?.message.id ?? null,
          }
        : null,
  }
}

async function withNeedsOfOtherProjectsSoABlockerReadsItsRealState(team: Team, tasks: MessageView[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const missing = [...new Set(tasks.flatMap((t) => t.task?.needs ?? []))].filter((id) => !byId.has(id))
  for (const m of await Promise.all(missing.map((id) => team.thread(id, { limit: 1 }).then((t) => t.message)))) byId.set(m.id, m)
  return byId
}

const underAnOpenSpecThePanelTicks = (parent: MessageView | undefined) => !!parent && !closed(parent.task)

export async function boardData(team: Team, project?: string, dir: string | null = null, now = Date.now() / 1000) {
  const tasks = (await tasksOf(team, project)).filter((m) => m.task && m.task.state !== 'canceled' && m.task.state !== 'failed')
  const [byId, hist] = await Promise.all([withNeedsOfOtherProjectsSoABlockerReadsItsRealState(team, tasks), historiesFromTheFeedSinceTheOldestTask(team, tasks, project)])
  const byKey = new Map(tasks.map((t) => [key(t), t]))
  const rows = tasks
    .map((m) => ({ m, h: hist.get(m.id)! }))
    .sort((a, b) => b.h.active - a.h.active || (key(a.m) < key(b.m) ? -1 : 1))
  const columns: Record<string, unknown[]> = { open: [], in_progress: [], done: [] }
  for (const { m, h } of rows) {
    const r = row(m, h, byId, dir)
    const parent = m.labels.parent ? byKey.get(m.labels.parent) : undefined
    const doneStillShown = columns.done!.length < DONE_ALWAYS_SHOWN_LATEST || underAnOpenSpecThePanelTicks(parent) || (h.done ?? 0) >= now - DONE_ALSO_SHOWN_WITHIN
    if (r.status === 'done' && !doneStillShown) continue
    columns[r.status]!.push(r)
  }
  const decisions = rows
    .flatMap(({ m, h }) =>
      h.replies.flatMap((r) => {
        const d = data(r.message, 'nawaban-decision')
        return d && r.at >= now - DECISIONS_SHOWN_WITHIN_OPEN_OR_CLOSED ? [{ task: key(m), at: r.at, verdict: String(d.verdict), owner: d.by === 'user' }] : []
      }),
    )
    .sort((a, b) => b.at - a.at)
  const syncNote = dir && project ? await syncStalledNote(dir, project) : null
  return { columns: Object.entries(columns).map(([k, v]) => ({ key: k, tasks: v })), decisions, ...(syncNote ? { syncNote } : {}) }
}

export async function projectsData(team: Team) {
  const counts = new Map<string, { name: string; open: number; total: number; waiting: number }>()
  for (const m of await tasksOf(team)) {
    const p = counts.get(m.channel) ?? { name: m.channel, open: 0, total: 0, waiting: 0 }
    p.total++
    if (!closed(m.task)) {
      p.open++
      if (HOLDS_THE_DECISION_MAKER_ANSWERS.has(m.task?.blocked?.kind ?? '')) p.waiting++
    }
    counts.set(m.channel, p)
  }
  return { projects: [...counts.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) }
}

function eventAsTheOldCliWroteIt(r: Reply) {
  const [b] = r.message.blocks
  const kind = b ? b.schema.replace(/^nawaban-/, '') : 'note'
  const d = (b?.data ?? {}) as Record<string, unknown>
  const text =
    kind === 'note'
      ? r.message.text
      : kind === 'decision'
        ? [`决定：${d.verdict}`, `背景：${d.question}`, ...((d.rejected as string[]) ?? []).map((x) => `否决方案：${x}`)].join('\n')
        : kind === 'link'
          ? `${d.kind}:${d.ref}`
          : JSON.stringify(d)
  return { kind, body: text, author: d.by === 'user' ? 'user' : r.by, at: r.at }
}

const PULL_LINK = /^pr:(\S+)/

export async function taskDetail(team: Team, ref: string, pullStateOf: PullStateOf = noPullStates) {
  const [m] = await team.tasks.list({ state: 'all', label: { key: ref } }).then((p) => p.tasks.map((t) => t.message))
  const task = m ?? (await team.thread(ref.replace(/^#/, ''), { limit: 1 }).then((t) => t.message, () => null))
  if (!task?.task) throw new Refused(`任务不存在:${ref}`)
  const all = await tasksOf(team)
  const byId = await withNeedsOfOtherProjectsSoABlockerReadsItsRealState(team, all)
  const status = (x: MessageView) => (x.task!.state === 'completed' ? 'done' : x.task!.state === 'canceled' ? 'cancelled' : live(x.task) ? 'in_progress' : 'open')
  const ref_ = (x: MessageView) => ({ id: key(x), title: title(x), status: status(x) })
  const h = (await historiesFromTheFeedSinceTheOldestTask(team, [task], task.channel)).get(task.id)!
  const events = h.replies.map(eventAsTheOldCliWroteIt).reverse()
  const parent = all.find((x) => key(x) === task.labels.parent)
  const pullUrls = [...new Set(events.flatMap((e) => (e.kind === 'link' ? (PULL_LINK.exec(e.body)?.[1] ?? []) : [])))]
  const pullStates = await Promise.all(pullUrls.map(pullStateOf))
  return {
    id: key(task),
    title: title(task),
    body: body(task),
    status: status(task),
    project: task.channel,
    session: live(task.task) ? windowProfileElseName(task.task.claim!.actor) : null,
    created_at: secs(task.createdAt),
    parent: parent ? ref_(parent) : null,
    children: all.filter((x) => x.labels.parent === key(task)).map(ref_),
    blocked_by: (task.task.needs ?? []).flatMap((id) => (byId.get(id) ? [ref_(byId.get(id)!)] : [])),
    dependents: all.filter((x) => x.task?.needs?.includes(task.id)).map(ref_),
    latest_note: events.find((e) => e.kind === 'note') ?? null,
    decisions: events.filter((e) => e.kind === 'decision'),
    links: events.filter((e) => e.kind === 'link'),
    pulls: Object.fromEntries(pullUrls.flatMap((url, i) => (pullStates[i] ? [[url, pullStates[i]]] : []))),
    events,
    narration: await narrationOf(h.holds),
  }
}

export async function json(argv: string[], team: Team, dir: string): Promise<number> {
  let out
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { project: { type: 'string' } } })
    const [what, id] = positionals
    if (what === 'db' && positionals.length === 1) out = { db: await realpath(join(dir, 'local.db')) }
    else if (what === 'projects' && positionals.length === 1) out = await projectsData(team)
    else if (what === 'board' && positionals.length === 1) out = await boardData(team, values.project, dir)
    else if (what === 'task' && id && positionals.length === 2) out = await taskDetail(team, id)
    else throw new Refused('usage: nawaban json projects|db|board [--project <p>]|task <id>|okr [--repo <path>]', 2)
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as Error).message }) + '\n')
    return error instanceof Refused ? error.code : 1
  }
  process.stdout.write(JSON.stringify(out) + '\n')
  return 0
}
