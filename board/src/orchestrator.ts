import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import type { board } from '@vercel/board'
import { Refused } from './tasks.ts'
import { boardData, tasksOf } from './views.ts'

/**
 * What the orchestrator's window reads off the board: `nawaban index` when it starts (the SessionStart
 * hook), and `nawaban inbox` under each reply (the Stop hook). Both ported from the old nawaban/cli.py's
 * board path (index_text, inbox_line); the inbox reads the board each time, with no cache.
 */
type Team = ReturnType<typeof board>
type Row = {
  id: string
  title: string
  status: string
  parent: string | null
  session: string | null
  created_at: number
  active_at: number
  claimed_at: number | null
  done_at?: number | null
  progress?: { body: string; at: number } | null
  waiting?: string | null
  decision?: { at: number; verdict: string } | null
}
type Data = { columns: { key: string; tasks: Row[] }[]; decisions?: { task: string; at: number; verdict: string; owner: boolean }[] }

const STALE = 24 * 3600 // 在推 → 停了 past this long without activity
const BOOKKEEPING = /^\s*(?:triage|wayfinder|impact):/ // notes that are labels, not progress
const MENTION = /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_-]+)/u
const NEXT_SPLIT = /[，,]?\s*下一步[：:]/
const NEXT = /下一步[：:]\s*([^。\n]+)/
// A link runs to whitespace or CJK and full-width text.
const LINK = /https?:\/\/[^\s\u{3000}-\u{303f}\u{ff00}-\u{ffef}\u{4e00}-\u{9fff}]+/gu
// A hold the decision-maker answers: 等你 (needs_input) or a decision card (awaiting_approval).
const ASKS = new Set(['needs_input', 'awaiting_approval'])

const ago = (now: number, at: number) => {
  const m = Math.floor(Math.trunc(now - at) / 60)
  return m < 60 ? `${m} 分钟` : m < 48 * 60 ? `${Math.floor(m / 60)} 小时` : `${Math.floor(m / 1440)} 天`
}

/** One line: links as (链接), no ** or backticks, whitespace collapsed, cut at n characters. */
export function short(s: string, n: number): string {
  const one = s.replace(LINK, '(链接)').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()
  const chars = [...one]
  return chars.length <= n ? one : chars.slice(0, n).join('') + '…'
}

const two = (n: number) => String(n).padStart(2, '0')
const stamp = (at: number) => {
  const d = new Date(at * 1000)
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** The md index of `json board`'s data: 等你, 停了, 在推, the decision-maker's decisions, the untouched, the closed. */
export function indexText(data: Data, name: string, now = Date.now() / 1000): string {
  const tasks = data.columns.flatMap((c) => c.tasks)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const live = tasks.filter((t) => t.status !== 'done')
  const progress = (t: Row) => (t.progress && !BOOKKEEPING.test(t.progress.body) ? t.progress : null)
  const state = (t: Row) =>
    t.waiting != null ? '等你' : progress(t) || t.claimed_at || t.session ? (now - t.active_at > STALE ? '停了' : '在推') : '没动'
  const belongs = (t: Row) => {
    if (!t.parent) return ''
    const p = byId.get(t.parent)
    return ` · 属于 ${t.parent}` + (p ? ` ${short(p.title.replace(/^[\p{L}\p{N}_]+:\s*/u, ''), 16)}` : '')
  }
  const groups = (['等你', '停了', '在推'] as const).map(
    (k) => [k, live.filter((t) => state(t) === k).sort((a, b) => a.active_at - b.active_at)] as const,
  )
  const moving = new Set(groups.flatMap(([, g]) => g.map((t) => t.parent)))
  const idle = live.filter((t) => state(t) === '没动' && !moving.has(t.id)).sort((a, b) => b.created_at - a.created_at)
  const out = [
    `${name} 进行中的事 · ${stamp(now)} 生成`,
    groups.map(([k, g]) => `${k} ${g.length}`).join(' · ') + ` · 没动 ${idle.length}`,
    '',
  ]
  for (const [k, g] of groups) {
    if (!g.length) continue
    out.push(`## ${k}`)
    for (const t of g) {
      const p = progress(t)
      const d = t.decision
      if (k === '停了') {
        const mention = p ? MENTION.exec(p.body) : null
        out.push(`- ${t.id} ${short(t.title, 34)}${belongs(t)}（${ago(now, t.active_at)}没动静 · 停在：${mention ? '@' + mention[1] : '没写'}）`)
      } else out.push(`- ${t.id} ${short(t.title, 34)}${belongs(t)}`)
      if (p) out.push(`  进展 ${ago(now, p.at)}前：${short(p.body.split(NEXT_SPLIT)[0]!, 70)}`)
      const next = p ? NEXT.exec(p.body) : null
      if (t.waiting) {
        if (t.waiting !== '等你') out.push(`  下一步：${short(t.waiting, 90)}`)
      } else if (next && !(d && p && d.at > p.at)) out.push(`  下一步：${short(next[1]!, 90)}`)
      else if (d) out.push(`  最近决定 ${ago(now, d.at)}前：${short(d.verdict, 80)}`)
    }
    out.push('')
  }
  const decided = data.decisions ?? []
  const own = decided.filter((d) => d.owner)
  out.push(`## 48 小时内你拍的板 ${own.length}（agent 自己定的另有 ${decided.length - own.length} 条，在各任务里）`)
  out.push(...own.map((d) => `- ${ago(now, d.at)}前 ${d.task} ${short(d.verdict, 70)}`))
  out.push('', `## 没动 ${idle.length}（开着，从没认领也没写进展）`)
  out.push(...idle.map((t) => `- ${t.id} ${short(t.title, 40)}${belongs(t)}`))
  // ponytail: json board keeps only the latest done tasks (12, plus those of 24 h), so this may undercount.
  const closed = tasks.filter((t) => t.status === 'done' && now - (t.done_at ?? 0) < 48 * 3600).length
  return [...out, '', `48 小时内关了 ${closed} 个。`].join('\n')
}

const fail = (error: unknown) => {
  process.stderr.write(`error: ${(error as Error).message}\n`)
  return error instanceof Refused ? error.code : 1
}

/** `nawaban index [--project <p>]`: the index on stdout; it writes nothing. */
export async function index(argv: string[], team: Team): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { project: { type: 'string' } } })
    process.stdout.write(indexText((await boardData(team, values.project)) as Data, values.project ?? '看板') + '\n')
    return 0
  } catch (error) {
    return fail(error)
  }
}

/**
 * `待你决定 N 件：<the ones this session wasn't shown>｜说「同步」看卡`, `待你决定 N 件（无变化）` when it was
 * shown the same set last, `待你决定 0 件` once when none waits (so a quiet inbox reads as working), then null. `seen` is that last set.
 */
export function inboxLine(items: { id: string; title: string }[], seen: string[] | null): string | null {
  if (!items.length) return seen && !seen.length ? null : '待你决定 0 件'
  const ids = items.map((i) => i.id)
  if (seen && seen.length === ids.length && ids.every((id) => seen.includes(id))) return `待你决定 ${items.length} 件（无变化）`
  const fresh = items.filter((i) => !seen?.includes(i.id))
  const listed = short((fresh.length ? fresh : items).map((i) => `${i.id} ${short(i.title, 24)}`).join(' · '), 90)
  return `待你决定 ${items.length} 件：${listed}｜说「同步」看卡`
}

/**
 * `nawaban inbox [--project <p>]`: the Stop hook's line, its JSON on stdin (session_id). Prints
 * {"systemMessage": line}, or nothing when nothing waits. The project's tasks held for the
 * decision-maker are its items; what each session was shown last is kept in <dir>/inbox/.
 */
export async function inbox(argv: string[], team: Team, dir: string): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { project: { type: 'string' } } })
    const stop = JSON.parse((await text(process.stdin)) || '{}') as { session_id?: string }
    const items = (await tasksOf(team, values.project, 'blocked'))
      .filter((m) => ASKS.has(m.task?.blocked?.kind ?? ''))
      .map((m) => ({ id: m.labels.key ?? `#${m.id}`, title: m.text.split('\n')[0]! }))
    const file = join(dir, 'inbox', `seen-${(stop.session_id || 'x').replace(/[^\w-]/g, '_')}.json`)
    const seen = await readFile(file, 'utf8').then((s) => JSON.parse(s) as unknown, () => null)
    await mkdir(join(dir, 'inbox'), { recursive: true })
    await writeFile(`${file}.${process.pid}`, JSON.stringify(items.map((i) => i.id)))
    await rename(`${file}.${process.pid}`, file) // whole or not at all: a reader never sees half a file
    const line = inboxLine(items, Array.isArray(seen) ? seen : null)
    if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n')
    return 0
  } catch (error) {
    return fail(error)
  }
}
