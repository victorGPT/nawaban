import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { board } from '@vercel/board'
import { liveOrchestratorInRepository, mainCheckoutRealPathOf, stdoutOrNullOnFailure } from './dispatch.ts'
import { reposReadOnEveryUseSoEditsNeedNoRestart } from './impact.ts'
import { short } from './orchestrator.ts'
import { boardData, tasksOf } from './views.ts'

type Team = ReturnType<typeof board>
type Row = {
  id: string
  status: string
  session: string | null
  terminal: string | null
  waiting?: string | null
  progress?: { body: string } | null
  unclaimed_dispatch?: { terminal: string; at: number } | null
}
type Listed = { address: string; state?: string }
type Seen = { status?: { state?: string; msg?: string } | null; status_ms?: number | null }
type Kind = '卡住' | '没领' | '掉线' | '额度用完'
type Finding = { project: string; task: string; terminal: string; kind: Kind; minutes: number; last: string }
type Reported = Record<string, Kind>
type Unread = { unread: string }
type Look = Finding | Unread | null

const { heldTicketState } = (await import(new URL('../../herdr/mods/nawaban-board/logic.js', import.meta.url).href)) as {
  heldTicketState: (t: Row, window: { status: string } | null | undefined) => string
}

export const PATROL_EVERY_MS = 5 * 60_000
const MINUTE_MS = 60_000
const STUCK_AFTER_IDLE_MINUTES = 15
const UNCLAIMED_AFTER_MINUTES = 10
const HC_WORDS_FOR_SITTING_AT_THE_PROMPT = new Set(['idle', 'done'])
const OUT_OF_QUOTA = /rate.?limit|quota|usage limit|limit reached|额度/i
const SAID_BLOCKED_ON_THE_TICKET = /受阻/
const SCREEN_LINES_READ_FOR_QUOTA = 30
const LAST_LINE_CHARS = 80
const SAYS_SOMETHING = /[\p{L}\p{N}]/u
const REPORTED_FILE = 'patrol-reported.json'

async function hcJson<T>(args: string[]): Promise<T | null> {
  const out = await stdoutOrNullOnFailure('hc', args)
  try {
    return out === null ? null : (JSON.parse(out) as T)
  } catch {
    return null
  }
}

async function screenTail(terminal: string): Promise<string[]> {
  const read = await hcJson<{ text?: string }>(['read', terminal, '--json'])
  return (read?.text ?? '').split('\n').filter((l) => SAYS_SOMETHING.test(l)).slice(-SCREEN_LINES_READ_FOR_QUOTA)
}

async function findingOf(project: string, row: Row, live: Set<string>, holding: Set<string>, now: number): Promise<Look> {
  const at = (terminal: string, kind: Kind, minutes: number, last = '') => ({ project, task: row.id, terminal, kind, minutes, last })
  const unclaimed = row.unclaimed_dispatch
  if (!row.session) {
    if (!unclaimed || !live.has(unclaimed.terminal) || holding.has(unclaimed.terminal)) return null
    const minutes = Math.floor((now - unclaimed.at * 1000) / MINUTE_MS)
    return minutes >= UNCLAIMED_AFTER_MINUTES ? at(unclaimed.terminal, '没领', minutes, await lastLineOf(unclaimed.terminal)) : null
  }
  if (!row.terminal) return null
  if (!live.has(row.terminal)) return heldTicketState(row, null) === 'stopped' ? at(row.terminal, '掉线', 0) : null
  const seen = await hcJson<Seen>(['get', row.terminal, '--json'])
  if (!seen) return { unread: problemKey({ project, task: row.id, terminal: row.terminal }) }
  const word = seen.status?.state ?? ''
  const minutes = seen.status_ms ? Math.floor((now - seen.status_ms) / MINUTE_MS) : 0
  if (word === 'working') return null
  const tail = await screenTail(row.terminal)
  const last = short(seen.status?.msg || tail.at(-1) || '', LAST_LINE_CHARS)
  if ([seen.status?.msg ?? '', ...tail].some((l) => OUT_OF_QUOTA.test(l))) return at(row.terminal, '额度用完', minutes, last)
  const window = { status: HC_WORDS_FOR_SITTING_AT_THE_PROMPT.has(word) ? 'idle' : word }
  const stuck = heldTicketState(row, window) === 'stopped' && minutes >= STUCK_AFTER_IDLE_MINUTES && !SAID_BLOCKED_ON_THE_TICKET.test(row.progress?.body ?? '')
  return stuck ? at(row.terminal, '卡住', minutes, last) : null
}

async function lastLineOf(terminal: string): Promise<string> {
  const seen = await hcJson<Seen>(['get', terminal, '--json'])
  return short(seen?.status?.msg || (await screenTail(terminal)).at(-1) || '', LAST_LINE_CHARS)
}

export function patrolLine(f: Finding): string {
  const last = f.last ? `，最后一行：${f.last}` : ''
  if (f.kind === '卡住') return `巡检：${f.terminal} 卡住 ${f.minutes} 分钟，持 ${f.task}${last}`
  if (f.kind === '没领') return `巡检：${f.terminal} 被指派 ${f.task} ${f.minutes} 分钟没认领${last}`
  if (f.kind === '掉线') return `巡检：${f.terminal} 终端已死，还持 ${f.task}`
  return `巡检：${f.terminal} 额度用完，持 ${f.task}${last}`
}

const problemKey = (f: Pick<Finding, 'project' | 'task' | 'terminal'>) => `${f.project}|${f.task}|${f.terminal}`
const ofProject = (project: string) => (k: string) => k.startsWith(`${project}|`)

async function reportedBefore(dir: string): Promise<Reported> {
  return readFile(join(dir, REPORTED_FILE), 'utf8').then((s) => JSON.parse(s) as Reported, () => ({}))
}

async function rememberWhole(dir: string, reported: Reported) {
  await mkdir(dir, { recursive: true })
  const file = join(dir, REPORTED_FILE)
  await writeFile(`${file}.${process.pid}`, JSON.stringify(reported))
  await rename(`${file}.${process.pid}`, file)
}

async function delivered(team: Team, f: Finding, orch: string | null): Promise<boolean> {
  const line = patrolLine(f)
  if (orch && (await stdoutOrNullOnFailure('hc', ['send', orch, line])) !== null) return true
  const task = (await tasksOf(team, f.project)).find((m) => (m.labels.key ?? `#${m.id}`) === f.task)
  if (!task) return false
  await team.reply(task.id, line)
  return true
}

export async function patrolOnce(team: Team, dir: string, now = Date.now(), log: (line: string) => void = () => {}) {
  const listed = await hcJson<{ terminals?: Listed[] }>(['ls', '--json'])
  if (!listed?.terminals) return log('巡检：hc ls 读不到，这一轮跳过')
  const live = new Set(listed.terminals.filter((t) => t.state === 'live').map((t) => t.address))
  const before = await reportedBefore(dir)
  const after: Reported = {}
  for (const [project, checkout] of Object.entries(await reposReadOnEveryUseSoEditsNeedNoRestart(dir))) {
    try {
      const rows = ((await boardData(team, project)).columns as { key: string; tasks: Row[] }[]).filter((c) => c.key !== 'done').flatMap((c) => c.tasks)
      const holding = new Set(rows.filter((r) => r.session && r.terminal).map((r) => r.terminal!))
      const looks = await Promise.all(rows.map((r) => findingOf(project, r, live, holding, now)))
      for (const { unread } of looks.filter((l): l is Unread => l !== null && 'unread' in l)) if (before[unread]) after[unread] = before[unread]
      const findings = looks.filter((l): l is Finding => l !== null && !('unread' in l))
      const fresh = findings.filter((f) => before[problemKey(f)] !== f.kind)
      const root = fresh.length ? await mainCheckoutRealPathOf(checkout) : null
      const orch = root ? await liveOrchestratorInRepository(root) : null
      for (const f of findings) {
        if (!fresh.includes(f) || (await delivered(team, f, orch))) after[problemKey(f)] = f.kind
      }
    } catch (error) {
      log(`巡检：${project} 这一轮没看完（${(error as Error).message}）`)
      for (const k of Object.keys(before).filter(ofProject(project))) after[k] = before[k]!
    }
  }
  await rememberWhole(dir, after)
}

export function patrolForever(team: Team, dir: string, log: (line: string) => void) {
  const sweep = () => patrolOnce(team, dir, Date.now(), log).catch((error) => log(`巡检出错：${(error as Error).message}`))
  setInterval(sweep, PATROL_EVERY_MS).unref()
  void sweep()
}
