import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { block, BoardError, type board, type MessageView } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { declarationId, declareOnIssueThread, GITHUB_ISSUE_TICKET, githubRepoOfChannel, oldRowsAsDeclaration } from './github-impact.ts'
import { okrChannel, keepAs, key, type Reading } from './okr.ts'
import { SCHEMAS } from './schemas.ts'
import { Refused } from './said.ts'

type Team = ReturnType<typeof board>
type Task = { id: string; project: string; parent: string | null; title: string; body: string; session: string | null }
type Event = { id: number; task: string; at: number; author: string; kind: string; body: string }
type Impact = { repo: string; ticket: string; objective: string; kr: string; dir: string; before: string | null; after: string | null; basis: string | null; declared_at: string }
type Counted = 'tasks' | 'replies' | '等你' | 'readings' | 'accepts' | 'impacts'
type NewAndAlreadyThere = Record<Counted, [number, number]>
type ProjectOfRepo = (repo: string) => string | null
type GithubRepoOf = (project: string, checkout: string) => Promise<string | null>
type OkrWrite = { at: string; kind: 'readings' | 'accepts' | 'impacts'; write: () => Promise<boolean> }

const MESSAGE_TEXT_MAX = 10_000
const HOLD_REASON_MAX = 1_000
const OLD_CLI_NEEDS_INFO_TRIAGE = /^triage:\s*needs-info[\s—–:：-]*(?:等你\s*[:：])?\s*/
const ID_HASH_LENGTH = 32
const usage = 'usage: nawaban import --from <old nawaban.db> --project <p> [--project <p>]… [--repos <repos.md>] [--okr-only]'

const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, ID_HASH_LENGTH)
const cut = (s: string, max: number, tail: string) => (s.length <= max ? s : s.slice(0, max - tail.length) + tail)
const stamp = (at: number) => new Date(at * 1000).toLocaleString('sv-SE')
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

export function waiting(triage: string | undefined): string | null {
  const t = triage?.trim()
  const m = t ? OLD_CLI_NEEDS_INFO_TRIAGE.exec(t) : null
  return m ? t!.slice(m[0].length) : null
}

const holdReasonFor = (question: string) => cut(question || '等你', HOLD_REASON_MAX, '…')

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

const repoFolderNamedAfter = (project: string, paths: string[]) => paths.find((x) => basename(x) === project)

async function addRepoForEachProjectWithout(dir: string, projects: string[], paths: string[]) {
  const file = join(dir, 'repos.json')
  const map: Record<string, string> = await readFile(file, 'utf8').then(JSON.parse, (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  })
  const added = []
  for (const p of projects) {
    const path = repoFolderNamedAfter(p, paths)
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

function blockersFirst(tasks: Task[], needs: Map<string, string[]>) {
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

const EDGES_OF_OPEN_BLOCKERS_ONLY_SINCE_DONE_OR_CANCELLED_HOLDS_NOTHING =
  "SELECT b.task, b.blocker FROM blockers b JOIN tasks t ON t.id = b.blocker WHERE t.status = 'open' ORDER BY b.task, b.blocker"

function readOldReadOnly(from: string, projects: string[]) {
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
    const edges = all<{ task: string; blocker: string }>(EDGES_OF_OPEN_BLOCKERS_ONLY_SINCE_DONE_OR_CANCELLED_HOLDS_NOTHING).filter((e) => open.has(e.task))
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
      readings: all<{ repo: string; kr: string; value: string; as_of: string; source: string; measured_at: string; def_hash?: string }>('SELECT * FROM kr_readings ORDER BY measured_at, rowid'),
      accepts: all<{ repo: string; objective: string; accepted_at: string }>('SELECT * FROM okr_accepts ORDER BY accepted_at, rowid'),
      impacts: all<Impact>('SELECT * FROM kr_impacts ORDER BY declared_at, rowid'),
    }
  } finally {
    db.close()
  }
}
type Old = ReturnType<typeof readOldReadOnly>

function refuseBlockersOutsideTheImport(old: Old, ids: Map<string, string>) {
  const outside = old.edges.filter((e) => !ids.has(e.blocker))
  if (outside.length) throw new Refused(`these wait for open tasks of a project not imported: ${outside.map((e) => `${e.task} ← ${e.blocker}`).join(', ')}`)
}

async function reposKnownBeforeAnyDeclarationSoBoardCanCheckNames(dir: string, projects: string[], reposMd: string, old: Old) {
  const md = await readFile(reposMd, 'utf8').catch(() => '')
  const paths = [...md.matchAll(/`((?:~|\/)[^`\s]+)`/g)].map((m) => m[1]!)
  return addRepoForEachProjectWithout(dir, projects, [...paths, ...old.readings, ...old.accepts, ...old.impacts].map((r) => (typeof r === 'string' ? r : r.repo)))
}

async function bodyTooLongForAMessageAsAttachment(team: Team, t: Task, text: string) {
  if (text.length <= MESSAGE_TEXT_MAX) return { text, attachments: [] }
  const attachments = [await team.upload({ data: new TextEncoder().encode(t.body), name: 'body.md', type: 'text/markdown' })]
  return { text: cut(text, MESSAGE_TEXT_MAX, '\n\n（正文超过 10,000 字，已截断；全文在附件 body.md）'), attachments }
}

async function tasksBlockersFirstFoundByKey(team: Team, old: Old, ids: Map<string, string>, n: NewAndAlreadyThere) {
  const needs = new Map<string, string[]>()
  for (const e of old.edges) needs.set(e.task, [...(needs.get(e.task) ?? []), e.blocker])
  for (const t of blockersFirst(old.tasks, needs)) {
    const found = (await team.tasks.list({ state: 'all', label: { key: t.id }, limit: 1 })).tasks[0]?.message
    if (found) {
      ids.set(t.id, found.id)
      n.tasks[1]++
      continue
    }
    const { text, attachments } = await bodyTooLongForAMessageAsAttachment(team, t, t.body ? `${t.title}\n\n${t.body}` : t.title)
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
}

async function latestWordEachUnderItsOwnId(team: Team, old: Old, t: Task, id: string, n: NewAndAlreadyThere) {
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
    await team.reply(id, { id: replyId, text: head + cut(body, MESSAGE_TEXT_MAX - head.length, '\n\n（已截断，全文见旧库）') })
    n.replies[0]++
  }
}

async function holdForAPersonNeedsNoClaim(team: Team, old: Old, t: Task, id: string, n: NewAndAlreadyThere) {
  const question = waiting(old.triage.get(t.id)?.body)
  if (question === null) return
  if ((await team.thread(id, { limit: 1 })).message.task?.blocked) n['等你'][1]++
  else {
    await team.tasks.block(id, holdReasonFor(question), { kind: 'needs_input' })
    n['等你'][0]++
  }
}

function readingsThroughOkrsOwnKeepingSoTheNextOkrFindsThem(team: Team, old: Old, projectOf: ProjectOfRepo): OkrWrite[] {
  return old.readings.flatMap((r) => {
    const p = projectOf(r.repo)
    const reading = { kr: r.kr, value: r.value, as_of: r.as_of, source: r.source, ...(r.def_hash ? { def_hash: r.def_hash } : {}) } as Reading
    return p ? [{ at: r.measured_at, kind: 'readings' as const, write: async () => {
      const id = key(p, r.kr, r.as_of, r.source, ...(r.def_hash ? [r.value, r.def_hash, r.measured_at] : []))
      if (await posted(team, id)) return false
      await keepAs(team, p, reading, id)
      return true
    } }] : []
  })
}

function acceptsUnderTheirOwnIds(team: Team, old: Old, projectOf: ProjectOfRepo): OkrWrite[] {
  return old.accepts.flatMap((a) => {
    const p = projectOf(a.repo)
    const id = 'okr-accept-' + hash(a.repo, a.objective, a.accepted_at)
    const text = block('nawaban-okr-accept@1', { objective: a.objective })
    return p ? [{ at: a.accepted_at, kind: 'accepts' as const, write: async () => !(await posted(team, id)) && !!(await team.post(okrChannel(p), { id, text })) }] : []
  })
}

async function declarationsOnImportedTasksAndIssues(team: Team, old: Old, ids: Map<string, string>, projectOf: ProjectOfRepo, githubRepoOf: GithubRepoOf) {
  const declared = new Map<string, Impact[]>()
  for (const i of old.impacts) {
    const k = [i.repo, i.ticket, i.objective, i.declared_at].join('\0')
    declared.set(k, [...(declared.get(k) ?? []), i])
  }
  const writes: OkrWrite[] = []
  const onIssueThreads: { project: string; id: string }[] = []
  const countedNotKeptForHavingNoThreadHere = []
  for (const rows of declared.values()) {
    const i = rows[0]!
    const p = projectOf(i.repo)
    if (!p) continue
    const id = declarationId(i)
    const task = ids.get(i.ticket)
    const repo = !task && GITHUB_ISSUE_TICKET.test(i.ticket) ? await githubRepoOf(p, i.repo) : null
    if (task) writes.push({ at: i.declared_at, kind: 'impacts', write: async () => !(await posted(team, id)) && !!(await team.reply(task, { id, text: oldRowsAsDeclaration(rows) })) })
    else if (repo) {
      onIssueThreads.push({ project: p, id })
      writes.push({ at: i.declared_at, kind: 'impacts', write: () => declareOnIssueThread(team, p, repo, rows) })
    } else countedNotKeptForHavingNoThreadHere.push(`${i.ticket}(${rows.length})`)
  }
  return { writes, onIssueThreads, skipped: countedNotKeptForHavingNoThreadHere }
}

async function inTheOrderMadeSoEachRoundIsWhenItLands(writes: OkrWrite[], n: NewAndAlreadyThere) {
  for (const w of writes.sort((a, b) => order(a.at, b.at))) n[w.kind][(await w.write()) ? 0 : 1]++
}

export async function importOld(argv: string[], team: Team, dir: string): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { from: { type: 'string' }, project: { type: 'string', multiple: true }, repos: { type: 'string' }, 'okr-only': { type: 'boolean' } },
    })
    const { from, project: projects = [], repos = join(homedir(), '.claude', 'repos.md'), 'okr-only': okrOnly } = values
    if (!from || !projects.length || positionals.length) throw new Refused(usage, 2)
    const old = readOldReadOnly(from, okrOnly ? [] : projects)
    const ids = new Map(old.tasks.map((t) => [t.id, '']))
    refuseBlockersOutsideTheImport(old, ids)

    const projectOfRepoFolder: ProjectOfRepo = (repo) => (projects.includes(basename(repo)) ? basename(repo) : null)
    const known = await reposKnownBeforeAnyDeclarationSoBoardCanCheckNames(dir, projects, repos, old)

    const n: NewAndAlreadyThere = {
      tasks: [0, 0],
      replies: [0, 0],
      '等你': [0, 0],
      readings: [0, 0],
      accepts: [0, 0],
      impacts: [0, 0],
    }
    await tasksBlockersFirstFoundByKey(team, old, ids, n)
    for (const t of old.tasks) {
      const id = ids.get(t.id)!
      await latestWordEachUnderItsOwnId(team, old, t, id, n)
      await holdForAPersonNeedsNoClaim(team, old, t, id, n)
    }

    const githubRepos = new Map<string, Promise<string | null>>()
    const githubRepoOf: GithubRepoOf = (p, checkout) => {
      if (!githubRepos.has(p)) githubRepos.set(p, githubRepoOfChannel(dir, p, checkout))
      return githubRepos.get(p)!
    }
    const declarations = await declarationsOnImportedTasksAndIssues(team, old, ids, projectOfRepoFolder, githubRepoOf)
    await inTheOrderMadeSoEachRoundIsWhenItLands(
      [...readingsThroughOkrsOwnKeepingSoTheNextOkrFindsThem(team, old, projectOfRepoFolder), ...acceptsUnderTheirOwnIds(team, old, projectOfRepoFolder), ...declarations.writes],
      n,
    )

    const checked = await compareOldWithBoard(team, projects, old, ids, projectOfRepoFolder, declarations.onIssueThreads)
    const out = [
      `imported ${projects.join(', ')} from ${from}`,
      ...Object.entries(n).map(([what, [made, had]]) => `  ${what.padEnd(9)} new ${made}, already there ${had}`),
      declarations.skipped.length ? `  declarations of tasks not imported, not kept: ${declarations.skipped.join(', ')}` : null,
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

const OKR_THREADS_PAGE = 500
const oldRowsOfOneDeclarationEachKrOrOneForNone = (krs: unknown[]) => Math.max(1, krs.length)

async function okrBlocksOnBoard(team: Team, p: string) {
  let readings = 0
  let accepts = 0
  for (let page = await team.threads({ channel: okrChannel(p), limit: OKR_THREADS_PAGE }); ; page = await team.threads({ channel: okrChannel(p), limit: OKR_THREADS_PAGE, before: page.older! })) {
    for (const t of page.threads) {
      const { message, replies } = await team.thread(t.message.id)
      for (const m of [message, ...replies]) {
        readings += m.blocks.filter((b) => b.schema === 'nawaban-kr-reading' || b.schema === 'nawaban-kr-failure').length
        accepts += m.blocks.filter((b) => b.schema === 'nawaban-okr-accept').length
      }
    }
    if (!page.older) break
  }
  return { readings, accepts }
}

async function compareOldWithBoard(team: Team, projects: string[], old: Old, ids: Map<string, string>, projectOf: ProjectOfRepo, onIssueThreads: { project: string; id: string }[]) {
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
  const heldLandsUnclaimedListedWithItsState: string[] = []
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
        return hold?.kind === 'needs_input' && hold.reason === holdReasonFor(waiting(old.triage.get(t.id)!.body)!)
      }).length,
    )
    const holding = mine.filter((t) => t.session)
    check(p, 'held → held-by label', holding.length, holding.filter((t) => now.get(t.id)?.labels['held-by'] === t.session).length)
    for (const t of holding) heldLandsUnclaimedListedWithItsState.push(`${t.id} ${now.get(t.id)?.task?.state}`)
    const { readings, accepts } = await okrBlocksOnBoard(team, p)
    let impacts = 0
    const countImpactsIn = (r: MessageView) => {
      for (const b of r.blocks) if (b.schema === 'nawaban-impact') impacts += oldRowsOfOneDeclarationEachKrOrOneForNone((b.data as { krs: unknown[] }).krs)
    }
    for (const t of mine) for (const r of thread.get(t.id) ?? []) countImpactsIn(r)
    for (const { id } of onIssueThreads.filter((d) => d.project === p)) {
      const m = await team.posted(id).catch(() => null)
      if (m) countImpactsIn(m)
    }
    const of = (table: { repo: string }[]) => table.filter((r) => projectOf(r.repo) === p).length
    check(p, 'kr_readings', of(old.readings), readings)
    check(p, 'okr_accepts', of(old.accepts), accepts)
    const onAnIssueThread = new Set(onIssueThreads.map((d) => d.id))
    const declarationsOfImportedTasks = old.impacts.filter((i) => ids.has(i.ticket) || onAnIssueThread.has(declarationId(i)))
    check(p, 'kr_impacts', of(declarationsOfImportedTasks), impacts)
  }
  const text = [
    `${'project'.padEnd(12)} ${'check'.padEnd(22)}  old  board`,
    ...rows,
    heldLandsUnclaimedListedWithItsState.length ? `held tasks now: ${heldLandsUnclaimedListedWithItsState.join(', ')}` : null,
    bad.length ? `✗ differs: ${bad.join(', ')}` : '✓ the board agrees with the old one',
  ]
  return { ok: !bad.length, text: text.filter((l) => l !== null).join('\n') }
}
