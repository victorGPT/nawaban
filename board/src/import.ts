import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { block, BoardError, type board, type MessageView } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { okrChannel, record, type Reading } from './okr.ts'
import { SCHEMAS } from './schemas.ts'
import { Refused } from './tasks.ts'

/**
 * nawaban import --from <old nawaban.db> --project <p>…: what board-tracked projects still have open on
 * the old board, onto this one (docs/specs/board-migration.md, 迁移与并行期 阶段 1). The old file is
 * opened read-only. Every write has an ID of its own and is skipped when the board already has it, so
 * running it again adds nothing; a task is also found by its key, as nawaban create made it.
 */
type Team = ReturnType<typeof board>
type Task = { id: string; project: string; parent: string | null; title: string; body: string; session: string | null }
type Event = { id: number; task: string; at: number; author: string; kind: string; body: string }
type Impact = { repo: string; ticket: string; objective: string; kr: string; dir: string; before: string | null; after: string | null; basis: string | null; declared_at: string }

const TEXT_MAX = 10_000 // a message's text (docs/01-board/04-messages.md)
const REASON_MAX = 1_000 // a hold's reason on the local board (docs/04-reference/02-board.md, tasks)
// cli.py's _NEEDS_INFO: a task waits on the user when its latest triage note is "triage: needs-info — 等你：<question>".
const NEEDS_INFO = /^triage:\s*needs-info[\s—–:：-]*(?:等你\s*[:：])?\s*/

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
const cut = (s: string, max: number, tail: string) => (s.length <= max ? s : s.slice(0, max - tail.length) + tail)
const stamp = (at: number) => new Date(at * 1000).toLocaleString('sv-SE')
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The question a task waits on the user for, as the old panel showed it, or null when it waits on no one. */
export function waiting(triage: string | undefined): string | null {
  const t = triage?.trim()
  const m = t ? NEEDS_INFO.exec(t) : null
  return m ? t!.slice(m[0].length) : null
}
/** The hold's reason for that question. */
const reason = (question: string) => cut(question || '等你', REASON_MAX, '…')

/** An old decision as nawaban-decision@1, from its Question/Verdict/Rejected (or 问题/结论/否决) lines; null when it has neither. */
export function decision(body: string, author: string) {
  const lines = (...keys: string[]) => [...body.matchAll(new RegExp(`^[ \t]*(?:${keys.join('|')})[ \t]*[:：][ \t]*(.+)$`, 'gm'))].map((m) => m[1]!.trim())
  const value = {
    question: lines('Question', '问题')[0],
    verdict: lines('Verdict', '结论')[0],
    rejected: lines('Rejected', '否决'),
    by: author === 'user' ? 'user' : 'agent',
  }
  return checkValue(SCHEMAS['nawaban-decision@1'].schema, value) ? null : value
}

/** <dir>/repos.json with a repository added for each project that has none, from paths whose folder is named after it. */
async function writeRepos(dir: string, projects: string[], paths: string[]) {
  const file = join(dir, 'repos.json')
  const map: Record<string, string> = await readFile(file, 'utf8').then(JSON.parse, (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  })
  const added = []
  for (const p of projects) {
    // ponytail: a project is its repository's folder name, as the old CLI and the panel's repoName() name it.
    const path = paths.find((x) => basename(x) === p)
    if (map[p] === undefined && path) {
      map[p] = path
      added.push(p)
    }
  }
  if (added.length) await writeFile(file, JSON.stringify(map, null, 2) + '\n')
  return { file, added, missing: projects.filter((p) => map[p] === undefined) }
}

async function posted(team: Team, id: string) {
  return team.posted(id).then(
    () => true,
    (error) => {
      if (error instanceof BoardError && error.code === 'post_not_found') return false
      throw error
    },
  )
}

/** Old tasks ordered so each comes after the tasks it waits for. */
function ordered(tasks: Task[], needs: Map<string, string[]>) {
  const out: Task[] = []
  const seen = new Set<string>()
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const visit = (t: Task) => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    for (const b of needs.get(t.id) ?? []) visit(byId.get(b)!)
    out.push(t)
  }
  tasks.forEach(visit)
  return out
}

/** Everything import reads off the old board, for the given projects. */
function readOld(from: string, projects: string[]) {
  const url = pathToFileURL(from)
  url.search = 'mode=ro'
  const db = new DatabaseSync(url, { readOnly: true })
  try {
    const all = <T>(sql: string, ...args: string[]) => db.prepare(sql).all(...args) as T[]
    const tasks = all<Task>(
      `SELECT id, project, parent, title, body, session FROM tasks WHERE status = 'open' AND project IN (${projects.map(() => '?').join(',')}) ORDER BY created_at, id`,
      ...projects,
    )
    const open = new Set(tasks.map((t) => t.id))
    // Only an open blocker still holds: the old board readies a task once its blocker is done or cancelled.
    const edges = all<{ task: string; blocker: string }>(
      "SELECT b.task, b.blocker FROM blockers b JOIN tasks t ON t.id = b.blocker WHERE t.status = 'open' ORDER BY b.task, b.blocker",
    ).filter((e) => open.has(e.task))
    const latest = (kind: string, only = '') =>
      new Map(
        all<Event>(`SELECT * FROM events e WHERE kind = ? ${only} AND id = (SELECT max(id) FROM events WHERE task = e.task AND kind = ? ${only})`, kind, kind)
          .filter((e) => open.has(e.task))
          .map((e) => [e.task, e]),
      )
    return {
      tasks,
      edges,
      notes: latest('note'),
      decisions: latest('decision'),
      triage: latest('note', "AND ltrim(body) LIKE 'triage:%'"),
      readings: all<{ repo: string; kr: string; value: string; as_of: string; source: string; measured_at: string }>('SELECT * FROM kr_readings ORDER BY measured_at, rowid'),
      accepts: all<{ repo: string; objective: string; accepted_at: string }>('SELECT * FROM okr_accepts ORDER BY accepted_at, rowid'),
      impacts: all<Impact>('SELECT * FROM kr_impacts ORDER BY declared_at, rowid'),
    }
  } finally {
    db.close()
  }
}
type Old = ReturnType<typeof readOld>

const usage = 'usage: nawaban import --from <old nawaban.db> --project <p> [--project <p>]… [--repos <repos.md>]'

/** nawaban import: see the top of this file. Prints what it added and what was already there, then old against new. */
export async function importOld(argv: string[], team: Team, dir: string): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { from: { type: 'string' }, project: { type: 'string', multiple: true }, repos: { type: 'string' } },
    })
    const { from, project: projects = [], repos = join(homedir(), '.claude', 'repos.md') } = values
    if (!from || !projects.length || positionals.length) throw new Refused(usage, 2)
    const old = readOld(from, projects)
    const ids = new Map(old.tasks.map((t) => [t.id, '']))
    const outside = old.edges.filter((e) => !ids.has(e.blocker))
    if (outside.length) throw new Refused(`these wait for open tasks of a project not imported: ${outside.map((e) => `${e.task} ← ${e.blocker}`).join(', ')}`)

    // The OKR tables are keyed by repository: a project's rows are those of the repository named after it.
    const projectOf = (repo: string) => (projects.includes(basename(repo)) ? basename(repo) : null)
    // repos.json before any declaration: the board's middleware checks a declaration's names in the repository's okr.toml.
    const md = await readFile(repos, 'utf8').catch(() => '')
    const paths = [...md.matchAll(/`((?:~|\/)[^`\s]+)`/g)].map((m) => m[1]!)
    const known = await writeRepos(dir, projects, [...paths, ...old.readings, ...old.accepts, ...old.impacts].map((r) => (typeof r === 'string' ? r : r.repo)))

    // Each: [new, already there].
    const n: Record<'tasks' | 'replies' | '等你' | 'readings' | 'accepts' | 'impacts', [number, number]> = {
      tasks: [0, 0],
      replies: [0, 0],
      '等你': [0, 0],
      readings: [0, 0],
      accepts: [0, 0],
      impacts: [0, 0],
    }
    const needs = new Map<string, string[]>()
    for (const e of old.edges) needs.set(e.task, [...(needs.get(e.task) ?? []), e.blocker])
    for (const t of ordered(old.tasks, needs)) {
      const found = (await team.tasks.list({ state: 'all', label: { key: t.id }, limit: 1 })).tasks[0]?.message
      if (found) {
        ids.set(t.id, found.id)
        n.tasks[1]++
        continue
      }
      let text = t.body ? `${t.title}\n\n${t.body}` : t.title
      const attachments = []
      if (text.length > TEXT_MAX) {
        // ponytail: written only when the task is, so a run cut between the two leaves one stray file.
        attachments.push(await team.upload({ data: new TextEncoder().encode(t.body), name: 'body.md', type: 'text/markdown' }))
        text = cut(text, TEXT_MAX, '\n\n（正文超过 10,000 字，已截断；全文在附件 body.md）')
      }
      const { task } = await team.tasks.create(t.project, {
        id: t.id,
        text,
        attachments,
        labels: { key: t.id, ...(t.parent ? { parent: t.parent } : {}), ...(t.session ? { 'held-by': t.session } : {}) },
        needs: (needs.get(t.id) ?? []).map((b) => ids.get(b)!),
      })
      ids.set(t.id, task.id)
      n.tasks[0]++
    }

    for (const t of old.tasks) {
      const id = ids.get(t.id)!
      const events = [old.notes.get(t.id), old.decisions.get(t.id)].filter((e) => e !== undefined).sort((a, b) => a.id - b.id)
      for (const e of events) {
        const replyId = `import-${e.id}`
        if (await posted(team, replyId)) {
          n.replies[1]++
          continue
        }
        const head = `（旧库 ${e.kind} · ${stamp(e.at)} · ${e.author}）\n\n`
        const value = e.kind === 'decision' ? decision(e.body, e.author) : null
        const body = value ? block('nawaban-decision@1', value) : e.body
        await team.reply(id, { id: replyId, text: head + cut(body, TEXT_MAX - head.length, '\n\n（已截断，全文见旧库）') })
        n.replies[0]++
      }
      const question = waiting(old.triage.get(t.id)?.body)
      if (question === null) continue
      if ((await team.thread(id, { limit: 1 })).message.task?.blocked) n['等你'][1]++
      else {
        // 等你 is a hold for a person (docs/01-board/11-tasks.md), so it needs no claim.
        await team.tasks.block(id, reason(question), { kind: 'needs_input' })
        n['等你'][0]++
      }
    }

    // Readings, accepts, and declarations in the order they were made: each one's round is when its message lands.
    const writes: { at: string; kind: 'readings' | 'accepts' | 'impacts'; write: () => Promise<boolean> }[] = []
    for (const r of old.readings) {
      const p = projectOf(r.repo)
      // Through okr's own record, so the next nawaban okr finds these by the same IDs.
      const reading = { kr: r.kr, value: r.value, as_of: r.as_of, source: r.source } as Reading
      if (p) writes.push({ at: r.measured_at, kind: 'readings', write: async () => (await record(team, p, [reading])) > 0 })
    }
    for (const a of old.accepts) {
      const p = projectOf(a.repo)
      const id = 'okr-accept-' + hash(a.repo, a.objective, a.accepted_at)
      const text = block('nawaban-okr-accept@1', { objective: a.objective })
      if (p) writes.push({ at: a.accepted_at, kind: 'accepts', write: async () => !(await posted(team, id)) && !!(await team.post(okrChannel(p), { id, text })) })
    }
    const declared = new Map<string, Impact[]>()
    for (const i of old.impacts) {
      const k = [i.repo, i.ticket, i.objective, i.declared_at].join('\0')
      declared.set(k, [...(declared.get(k) ?? []), i])
    }
    const skipped = []
    for (const rows of declared.values()) {
      const i = rows[0]!
      if (!projectOf(i.repo)) continue
      const task = ids.get(i.ticket)
      if (!task) {
        // ponytail: a declaration on a task that's closed (or GitHub's #N) has no thread here; it's counted, not kept.
        skipped.push(`${i.ticket}(${rows.length})`)
        continue
      }
      const krs = rows.filter((r) => r.kr).map((r) => Object.fromEntries(Object.entries({ name: r.kr, dir: r.dir, before: r.before, after: r.after, basis: r.basis }).filter(([, v]) => v !== null)))
      const id = 'import-impact-' + hash(i.repo, i.ticket, i.objective, i.declared_at)
      const text = block('nawaban-impact@1', { objective: i.objective, krs })
      writes.push({ at: i.declared_at, kind: 'impacts', write: async () => !(await posted(team, id)) && !!(await team.reply(task, { id, text })) })
    }
    for (const w of writes.sort((a, b) => order(a.at, b.at))) n[w.kind][(await w.write()) ? 0 : 1]++

    const checked = await compare(team, projects, old, ids, projectOf)
    const out = [
      `imported ${projects.join(', ')} from ${from}`,
      ...Object.entries(n).map(([what, [made, had]]) => `  ${what.padEnd(9)} new ${made}, already there ${had}`),
      skipped.length ? `  declarations of tasks not imported, not kept: ${skipped.join(', ')}` : null,
      `  repos.json ${known.added.length ? `added ${known.added.join(', ')}` : 'unchanged'}${known.missing.length ? `, no repository for ${known.missing.join(', ')}` : ''} (${known.file})`,
      '',
      checked.text,
    ]
    process.stdout.write(out.filter((l) => l !== null).join('\n') + '\n')
    return checked.ok ? 0 : 1
  } catch (error) {
    const misuse = (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    if (!(error instanceof Refused || error instanceof BoardError || misuse)) throw error
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return error instanceof Refused ? error.code : misuse ? 2 : 1
  }
}

/** The old board against this one, each count read back off the board, and whether they all agree. */
async function compare(team: Team, projects: string[], old: Old, ids: Map<string, string>, projectOf: (repo: string) => string | null) {
  const now = new Map<string, MessageView>()
  const thread = new Map<string, MessageView[]>()
  for (const [key, id] of ids) {
    const { message, replies } = await team.thread(id)
    now.set(key, message)
    thread.set(key, replies)
  }
  const rows: string[] = []
  const bad: string[] = []
  const check = (p: string, what: string, want: number, got: number) => {
    rows.push(`${p.padEnd(12)} ${what.padEnd(22)} ${String(want).padStart(4)} ${String(got).padStart(6)}${want === got ? '' : '  ✗'}`)
    if (want !== got) bad.push(`${p} ${what}`)
  }
  const unfinished = (m?: MessageView) => !!m?.task && !['completed', 'canceled', 'failed'].includes(m.task.state)
  const held: string[] = []
  for (const p of projects) {
    const mine = old.tasks.filter((t) => t.project === p)
    check(p, 'open tasks', mine.length, mine.filter((t) => unfinished(now.get(t.id)) && now.get(t.id)!.channel === p).length)
    const edges = old.edges.filter((e) => mine.some((t) => t.id === e.task))
    check(p, 'blocker edges', edges.length, edges.filter((e) => now.get(e.task)?.task?.needs.includes(ids.get(e.blocker)!)).length)
    const asking = mine.filter((t) => waiting(old.triage.get(t.id)?.body) !== null)
    check(
      p,
      '等你 → needs_input',
      asking.length,
      asking.filter((t) => {
        const hold = now.get(t.id)?.task?.blocked
        return hold?.kind === 'needs_input' && hold.reason === reason(waiting(old.triage.get(t.id)!.body)!)
      }).length,
    )
    const holding = mine.filter((t) => t.session)
    check(p, 'held → held-by label', holding.length, holding.filter((t) => now.get(t.id)?.labels['held-by'] === t.session).length)
    // Held lands unclaimed: ready, or waiting while an open blocker holds it, or blocked when it asks the user.
    for (const t of holding) held.push(`${t.id} ${now.get(t.id)?.task?.state}`)
    let readings = 0
    let accepts = 0
    for (let page = await team.threads({ channel: okrChannel(p), limit: 500 }); ; page = await team.threads({ channel: okrChannel(p), limit: 500, before: page.older! })) {
      for (const t of page.threads) {
        const { message, replies } = await team.thread(t.message.id)
        for (const m of [message, ...replies]) {
          readings += m.blocks.filter((b) => b.schema === 'nawaban-kr-reading').length
          accepts += m.blocks.filter((b) => b.schema === 'nawaban-okr-accept').length
        }
      }
      if (!page.older) break
    }
    // An old row is one KR of a declaration, or the whole of one that names none (--o 无).
    let impacts = 0
    for (const t of mine) {
      for (const r of thread.get(t.id) ?? []) {
        for (const b of r.blocks) if (b.schema === 'nawaban-impact') impacts += Math.max(1, (b.data as { krs: unknown[] }).krs.length)
      }
    }
    const of = (table: { repo: string }[]) => table.filter((r) => projectOf(r.repo) === p).length
    check(p, 'kr_readings', of(old.readings), readings)
    check(p, 'okr_accepts', of(old.accepts), accepts)
    // A declaration of a task not imported isn't kept (it's listed above), so it isn't counted here either.
    check(p, 'kr_impacts', of(old.impacts.filter((i) => ids.has(i.ticket))), impacts)
  }
  const text = [
    `${'project'.padEnd(12)} ${'check'.padEnd(22)}  old  board`,
    ...rows,
    held.length ? `held tasks now: ${held.join(', ')}` : null,
    bad.length ? `✗ differs: ${bad.join(', ')}` : '✓ the board agrees with the old one',
  ]
  return { ok: !bad.length, text: text.filter((l) => l !== null).join('\n') }
}
