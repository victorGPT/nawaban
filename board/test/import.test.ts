import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { importOld } from '../src/import.ts'
import { load, okrChannel } from '../src/okr.ts'
import { registerSchemas } from '../src/schemas.ts'

let team: ReturnType<typeof board>
let dir = ''
let old = ''
let repos = ''

function oldBoard(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT, parent TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', session TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE blockers (task TEXT NOT NULL, blocker TEXT NOT NULL, PRIMARY KEY (task, blocker));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE kr_readings (repo TEXT NOT NULL, kr TEXT NOT NULL, value TEXT NOT NULL, as_of TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', measured_at TEXT NOT NULL);
    CREATE TABLE okr_accepts (repo TEXT NOT NULL, objective TEXT NOT NULL, accepted_at TEXT NOT NULL);
    CREATE TABLE kr_impacts (repo TEXT NOT NULL, ticket TEXT NOT NULL, objective TEXT NOT NULL, kr TEXT NOT NULL DEFAULT '', dir TEXT NOT NULL,
      before TEXT, after TEXT, basis TEXT, declared_at TEXT NOT NULL);
  `)
  const task = db.prepare('INSERT INTO tasks (id, project, parent, title, body, status, session, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  task.run('P-SPEC', 'proj', null, 'the spec', 'x'.repeat(12_000), 'open', null, 1)
  task.run('P-A', 'proj', 'P-SPEC', 'first', 'do a', 'open', 'sess-held', 2)
  task.run('P-B', 'proj', 'P-SPEC', 'second', '', 'open', null, 3)
  task.run('P-W', 'proj', null, 'asks', '', 'open', null, 4)
  task.run('P-DONE', 'proj', null, 'done', '', 'done', null, 0)
  task.run('P-C', 'proj', null, 'after done', '', 'open', null, 5)
  task.run('P-WB', 'proj', null, 'asks while it waits', '', 'open', null, 5)
  task.run('Q-1', 'other', null, 'not moved', '', 'open', null, 6)
  const blocker = db.prepare('INSERT INTO blockers VALUES (?, ?)')
  blocker.run('P-B', 'P-A')
  blocker.run('P-C', 'P-DONE')
  blocker.run('P-WB', 'P-A')
  const event = db.prepare('INSERT INTO events (task, at, author, kind, body) VALUES (?, ?, ?, ?, ?)')
  event.run('P-A', 10, 'sess-held', 'note', 'old progress')
  event.run('P-A', 11, 'sess-held', 'note', 'newest progress')
  event.run('P-A', 12, 'user', 'decision', 'Question: which way\nVerdict: this way\nRejected: that way - slower')
  event.run('P-B', 13, 'sess-x', 'decision', 'a decision in prose, no lines')
  event.run('P-B', 14, 'sess-x', 'note', 'triage: needs-info — 等你：answered since')
  event.run('P-B', 15, 'sess-x', 'note', 'triage: ready-for-agent')
  event.run('P-W', 16, 'sess-w', 'note', 'triage: needs-info — 等你：which port?')
  event.run('P-WB', 16, 'sess-w', 'note', 'triage: needs-info 等你: which host?')
  event.run('Q-1', 17, 'sess-q', 'note', 'not moved either')
  const reading = db.prepare('INSERT INTO kr_readings VALUES (?, ?, ?, ?, ?, ?)')
  reading.run('/src/proj', 'K1', '1', '2026-11-01', 'run a', '2026-11-01T10:00:00')
  reading.run('/src/proj', 'K1', '2', '2026-11-02', 'run b', '2026-11-02T10:00:00')
  reading.run('/src/other', 'K1', '9', '2026-11-02', 'run c', '2026-11-02T10:00:00')
  db.prepare('INSERT INTO okr_accepts VALUES (?, ?, ?)').run('/src/proj', 'O1', '2026-11-03T10:00:00')
  const impact = db.prepare('INSERT INTO kr_impacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  impact.run('/src/proj', 'P-A', 'O1', 'K1', '↑', '1', '2', '实测', '2026-11-01T12:00:00')
  impact.run('/src/proj', 'P-A', 'O1', 'K2', '=', null, null, null, '2026-11-01T12:00:00')
  impact.run('/src/proj', 'P-B', '无', '', '=', null, null, null, '2026-11-01T13:00:00')
  impact.run('/src/proj', 'P-DONE', '无', '', '=', null, null, null, '2026-11-01T14:00:00')
  db.close()
}

beforeAll(async () => {
  team = board({ backend: local({ memory: true }) })
  await registerSchemas(team)
  const tmp = await mkdtemp(join(tmpdir(), 'nawaban-import-'))
  dir = join(tmp, 'board')
  old = join(tmp, 'nawaban.db')
  repos = join(tmp, 'repos.md')
  oldBoard(old)
  await writeFile(repos, '- proj: a project. `~/src/proj` · remote\n- other: `~/src/other`\n')
})

async function importProj(...more: string[]) {
  let out = ''
  let err = ''
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true))
  const warn = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true))
  try {
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
    const code = await importOld(['--from', old, '--project', 'proj', '--repos', repos, ...more], team, dir)
    return { code, out, err }
  } finally {
    write.mockRestore()
    warn.mockRestore()
  }
}
const task = async (key: string) => (await team.tasks.list({ state: 'all', label: { key } })).tasks[0]!.message
const replies = async (key: string) => (await team.thread((await task(key)).id)).replies

async function everything() {
  const out = []
  for (const channel of ['proj', okrChannel('proj')]) {
    for (const t of (await team.threads({ channel, limit: 500 })).threads) out.push(await team.thread(t.message.id))
  }
  return JSON.stringify(out)
}
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')

it('carries the open tasks of a project, their blockers, holders, latest word, and 等你, read-only', async () => {
  const before = await sha(old)
  const r = await importProj()
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(r.out).toContain('✓ the board agrees with the old one')
  expect(await sha(old)).toBe(before)

  const keys = (await team.tasks.list({ channel: 'proj', state: 'all' })).tasks.map((t) => t.message.labels.key).sort()
  expect(keys).toEqual(['P-A', 'P-B', 'P-C', 'P-SPEC', 'P-W', 'P-WB'])
  const [a, b, c, w, spec] = await Promise.all(['P-A', 'P-B', 'P-C', 'P-W', 'P-SPEC'].map(task))
  expect(b!.task?.needs).toEqual([a!.id])
  expect(b!.labels.parent).toBe('P-SPEC')

  expect(c!.task?.needs).toEqual([])
  expect(c!.task?.state).toBe('ready')

  expect(a!.task?.state).toBe('ready')
  expect(a!.labels['held-by']).toBe('sess-held')
  expect(w!.task?.blocked).toMatchObject({ kind: 'needs_input', reason: 'which port?' })

  const wb = await task('P-WB')
  expect(wb.task?.needs).toEqual([a!.id])
  expect(wb.task?.blocked).toMatchObject({ kind: 'needs_input', reason: 'which host?' })

  expect(b!.task?.blocked).toBeFalsy()
  expect(spec!.text.length).toBeLessThanOrEqual(10_000)
  expect(spec!.attachments).toHaveLength(1)

  const ra = await replies('P-A')
  expect(ra.map((m) => m.text.split('\n\n').at(-1))).not.toContain('old progress')
  expect(ra.some((m) => m.text.endsWith('newest progress'))).toBe(true)
  expect(ra.flatMap((m) => m.blocks).find((x) => x.schema === 'nawaban-decision')?.data).toEqual({
    question: 'which way',
    verdict: 'this way',
    rejected: ['that way - slower'],
    by: 'user',
  })

  expect((await replies('P-B')).some((m) => m.text.endsWith('a decision in prose, no lines'))).toBe(true)
  expect(JSON.parse(await readFile(join(dir, 'repos.json'), 'utf8'))).toEqual({ proj: '~/src/proj' })
})

it('carries the OKR tables of the project, in the order they were made, and nothing of another', async () => {
  const { rows, accepts, declared } = await load(team, 'proj')
  expect(rows.map((r) => r.value)).toEqual(['1', '2'])
  expect([...accepts.keys()]).toEqual(['O1'])
  expect(declared.get('O1\0K1')?.map((d) => [d.ticket, d.dir, d.before, d.after, d.basis])).toEqual([['P-A', '↑', '1', '2', '实测']])
  expect(declared.get('O1\0K2')?.map((d) => d.dir)).toEqual(['='])

  expect(rows[0]!.measured_at < declared.get('O1\0K1')![0]!.declared_at).toBe(true)
  expect(declared.get('O1\0K1')![0]!.declared_at < rows[1]!.measured_at).toBe(true)
  expect(rows[1]!.measured_at < accepts.get('O1')!).toBe(true)
  const r = await importProj()
  expect(r.out).toContain('declarations of tasks not imported, not kept: P-DONE(1)')
})

it('adds nothing the second time', async () => {
  const before = await everything()
  const r = await importProj()
  expect(r.code).toBe(0)
  expect(r.out).not.toMatch(/new [1-9]/)
  expect(await everything()).toBe(before)
})

it('refuses a project whose tasks wait for an open task of one not imported', async () => {
  const db = new DatabaseSync(old)
  db.prepare('INSERT INTO blockers VALUES (?, ?)').run('P-C', 'Q-1')
  db.close()
  const r = await importProj()
  expect(r.code).toBe(1)
  expect(r.err).toContain('P-C ← Q-1')
})
