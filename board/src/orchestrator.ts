import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import type { board } from '@vercel/board'
import { Refused } from './tasks.ts'
import { boardData, tasksOf } from './views.ts'

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
type State = '等你' | '停了' | '在推' | '没动'

const HOUR = 3600
const STALLED_AFTER_QUIET_FOR = 24 * HOUR
const CLOSED_COUNTED_WITHIN_BUT_BOARD_KEEPS_ONLY_LATEST_DONE = 48 * HOUR
const HOURS_SHOWN_UNTIL_MINUTES = 48 * 60
const TITLE_WIDTH = 34
const IDLE_TITLE_WIDTH = 40
const SPEC_TITLE_WIDTH = 16
const PROGRESS_WIDTH = 70
const NEXT_STEP_WIDTH = 90
const DECISION_WIDTH = 80
const OWN_DECISION_WIDTH = 70
const INBOX_TITLE_WIDTH = 24
const INBOX_LINE_WIDTH = 90
const NOTE_THAT_IS_A_LABEL_NOT_PROGRESS = /^\s*(?:triage|wayfinder|impact):/
const MENTION = /(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_-]+)/u
const NEXT_SPLIT = /[，,]?\s*下一步[：:]/
const NEXT = /下一步[：:]\s*([^。\n]+)/
const LINK_UNTIL_WHITESPACE_OR_CJK_OR_FULL_WIDTH = /https?:\/\/[^\s\u{3000}-\u{303f}\u{ff00}-\u{ffef}\u{4e00}-\u{9fff}]+/gu
const HOLDS_THE_DECISION_MAKER_ANSWERS = new Set(['needs_input', 'awaiting_approval'])

const ago = (now: number, at: number) => {
  const m = Math.floor(Math.trunc(now - at) / 60)
  return m < 60 ? `${m} 分钟` : m < HOURS_SHOWN_UNTIL_MINUTES ? `${Math.floor(m / 60)} 小时` : `${Math.floor(m / 1440)} 天`
}

export function short(s: string, n: number): string {
  const one = s.replace(LINK_UNTIL_WHITESPACE_OR_CJK_OR_FULL_WIDTH, '(链接)').replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()
  const chars = [...one]
  return chars.length <= n ? one : chars.slice(0, n).join('') + '…'
}

const two = (n: number) => String(n).padStart(2, '0')
const stamp = (at: number) => {
  const d = new Date(at * 1000)
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

const progressNotBookkeeping = (t: Row) => (t.progress && !NOTE_THAT_IS_A_LABEL_NOT_PROGRESS.test(t.progress.body) ? t.progress : null)

function stateOf(t: Row, now: number): State {
  if (t.waiting != null) return '等你'
  const started = progressNotBookkeeping(t) || t.claimed_at || t.session
  if (!started) return '没动'
  return now - t.active_at > STALLED_AFTER_QUIET_FOR ? '停了' : '在推'
}

function nextStepLine(t: Row, now: number): string | null {
  const p = progressNotBookkeeping(t)
  const d = t.decision
  const next = p ? NEXT.exec(p.body) : null
  const decisionOvertakesNextStep = !!(d && p && d.at > p.at)
  if (t.waiting) return t.waiting !== '等你' ? `  下一步：${short(t.waiting, NEXT_STEP_WIDTH)}` : null
  if (next && !decisionOvertakesNextStep) return `  下一步：${short(next[1]!, NEXT_STEP_WIDTH)}`
  if (d) return `  最近决定 ${ago(now, d.at)}前：${short(d.verdict, DECISION_WIDTH)}`
  return null
}

function taskLines(k: State, t: Row, belongs: (t: Row) => string, now: number): string[] {
  const p = progressNotBookkeeping(t)
  const out = []
  if (k === '停了') {
    const mention = p ? MENTION.exec(p.body) : null
    out.push(`- ${t.id} ${short(t.title, TITLE_WIDTH)}${belongs(t)}（${ago(now, t.active_at)}没动静 · 停在：${mention ? '@' + mention[1] : '没写'}）`)
  } else out.push(`- ${t.id} ${short(t.title, TITLE_WIDTH)}${belongs(t)}`)
  if (p) out.push(`  进展 ${ago(now, p.at)}前：${short(p.body.split(NEXT_SPLIT)[0]!, PROGRESS_WIDTH)}`)
  const next = nextStepLine(t, now)
  if (next) out.push(next)
  return out
}

function decisionsLines(data: Data, now: number): string[] {
  const decided = data.decisions ?? []
  const own = decided.filter((d) => d.owner)
  return [
    `## 48 小时内你拍的板 ${own.length}（agent 自己定的另有 ${decided.length - own.length} 条，在各任务里）`,
    ...own.map((d) => `- ${ago(now, d.at)}前 ${d.task} ${short(d.verdict, OWN_DECISION_WIDTH)}`),
  ]
}

export function indexText(data: Data, name: string, now = Date.now() / 1000): string {
  const tasks = data.columns.flatMap((c) => c.tasks)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const live = tasks.filter((t) => t.status !== 'done')
  const belongs = (t: Row) => {
    if (!t.parent) return ''
    const p = byId.get(t.parent)
    return ` · 属于 ${t.parent}` + (p ? ` ${short(p.title.replace(/^[\p{L}\p{N}_]+:\s*/u, ''), SPEC_TITLE_WIDTH)}` : '')
  }
  const groups = (['等你', '停了', '在推'] as const).map(
    (k) => [k, live.filter((t) => stateOf(t, now) === k).sort((a, b) => a.active_at - b.active_at)] as const,
  )
  const specsWithMovingChildren = new Set(groups.flatMap(([, g]) => g.map((t) => t.parent)))
  const idle = live.filter((t) => stateOf(t, now) === '没动' && !specsWithMovingChildren.has(t.id)).sort((a, b) => b.created_at - a.created_at)
  const out = [
    `${name} 进行中的事 · ${stamp(now)} 生成`,
    groups.map(([k, g]) => `${k} ${g.length}`).join(' · ') + ` · 没动 ${idle.length}`,
    '',
  ]
  for (const [k, g] of groups) {
    if (!g.length) continue
    out.push(`## ${k}`, ...g.flatMap((t) => taskLines(k, t, belongs, now)), '')
  }
  out.push(...decisionsLines(data, now))
  out.push('', `## 没动 ${idle.length}（开着，从没认领也没写进展）`)
  out.push(...idle.map((t) => `- ${t.id} ${short(t.title, IDLE_TITLE_WIDTH)}${belongs(t)}`))
  const closedMayUndercount = tasks.filter((t) => t.status === 'done' && now - (t.done_at ?? 0) < CLOSED_COUNTED_WITHIN_BUT_BOARD_KEEPS_ONLY_LATEST_DONE).length
  return [...out, '', `48 小时内关了 ${closedMayUndercount} 个。`].join('\n')
}

const fail = (error: unknown) => {
  process.stderr.write(`error: ${(error as Error).message}\n`)
  return error instanceof Refused ? error.code : 1
}

export async function index(argv: string[], team: Team): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { project: { type: 'string' } } })
    process.stdout.write(indexText((await boardData(team, values.project)) as Data, values.project ?? '看板') + '\n')
    return 0
  } catch (error) {
    return fail(error)
  }
}

export function inboxLine(items: { id: string; title: string }[], shownLast: string[] | null): string | null {
  const alreadySaidNothingWaits = !!shownLast && !shownLast.length
  if (!items.length) return alreadySaidNothingWaits ? null : '待你决定 0 件'
  const ids = items.map((i) => i.id)
  const sameSetAsShownLast = !!shownLast && shownLast.length === ids.length && ids.every((id) => shownLast.includes(id))
  if (sameSetAsShownLast) return `待你决定 ${items.length} 件（无变化）`
  const fresh = items.filter((i) => !shownLast?.includes(i.id))
  const listed = short((fresh.length ? fresh : items).map((i) => `${i.id} ${short(i.title, INBOX_TITLE_WIDTH)}`).join(' · '), INBOX_LINE_WIDTH)
  return `待你决定 ${items.length} 件：${listed}｜说「同步」看卡`
}

async function writeWholeSoAReaderNeverSeesHalf(file: string, content: string) {
  await writeFile(`${file}.${process.pid}`, content)
  await rename(`${file}.${process.pid}`, file)
}

export async function inbox(argv: string[], team: Team, dir: string): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { project: { type: 'string' } } })
    const stop = JSON.parse((await text(process.stdin)) || '{}') as { session_id?: string }
    const items = (await tasksOf(team, values.project, 'blocked'))
      .filter((m) => HOLDS_THE_DECISION_MAKER_ANSWERS.has(m.task?.blocked?.kind ?? ''))
      .map((m) => ({ id: m.labels.key ?? `#${m.id}`, title: m.text.split('\n')[0]! }))
    const file = join(dir, 'inbox', `seen-${(stop.session_id || 'x').replace(/[^\w-]/g, '_')}.json`)
    const shownLast = await readFile(file, 'utf8').then((s) => JSON.parse(s) as unknown, () => null)
    await mkdir(join(dir, 'inbox'), { recursive: true })
    await writeWholeSoAReaderNeverSeesHalf(file, JSON.stringify(items.map((i) => i.id)))
    const line = inboxLine(items, Array.isArray(shownLast) ? shownLast : null)
    if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n')
    return 0
  } catch (error) {
    return fail(error)
  }
}
