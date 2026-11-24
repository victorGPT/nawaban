import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { syncStalledNote } from './github-sync-status.ts'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import type { board } from '@vercel/board'
import { mainCheckoutRealPathOf, terminalsThatMayBeWorkers } from './dispatch.ts'
import { seenOf } from './merge.ts'
import { all, Refused } from './tasks.ts'
import { boardData, tasksOf } from './views.ts'
import { openInboxItems, pageText, webAnswers, type InboxItem, type WebAnswer } from './page.ts'

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
type State = '等你' | '停滞' | '进行中' | '待办'

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
const NEXT_SPLIT = /[，,]?\s*(?:\/\s*)?(?:下一步|\bNext)[：:]/
const NEXT = /(?:下一步|\bNext)[：:]\s*(.+?)(?=\s*\/\s*(?:卡点|Blockers)\s*[：:]|[。\n]|$)/
const DONE_LABEL = /^\s*(?:已完成|Done)[：:]\s*/
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
  if (!started) return '待办'
  return now - t.active_at > STALLED_AFTER_QUIET_FOR ? '停滞' : '进行中'
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
  if (k === '停滞') {
    const mention = p ? MENTION.exec(p.body) : null
    out.push(`- ${t.id} ${short(t.title, TITLE_WIDTH)}${belongs(t)}（${ago(now, t.active_at)}没动静 · 停在：${mention ? '@' + mention[1] : '没写'}）`)
  } else out.push(`- ${t.id} ${short(t.title, TITLE_WIDTH)}${belongs(t)}`)
  if (p) out.push(`  进展 ${ago(now, p.at)}前：${short(p.body.split(NEXT_SPLIT)[0]!.replace(DONE_LABEL, ''), PROGRESS_WIDTH)}`)
  const next = nextStepLine(t, now)
  if (next) out.push(next)
  return out
}

function decisionsLines(data: Data, now: number): string[] {
  const decided = data.decisions ?? []
  const own = decided.filter((d) => d.owner)
  return [
    `## 48 小时内你的决策记录 ${own.length}（agent 自己定的另有 ${decided.length - own.length} 条，在各任务里）`,
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
  const groups = (['等你', '停滞', '进行中'] as const).map(
    (k) => [k, live.filter((t) => stateOf(t, now) === k).sort((a, b) => a.active_at - b.active_at)] as const,
  )
  const specsWithMovingChildren = new Set(groups.flatMap(([, g]) => g.map((t) => t.parent)))
  const idle = live.filter((t) => stateOf(t, now) === '待办' && !specsWithMovingChildren.has(t.id)).sort((a, b) => b.created_at - a.created_at)
  const out = [
    `${name} 进行中的事 · ${stamp(now)} 生成`,
    groups.map(([k, g]) => `${k} ${g.length}`).join(' · ') + ` · 待办 ${idle.length}`,
    '',
  ]
  for (const [k, g] of groups) {
    if (!g.length) continue
    out.push(`## ${k}`, ...g.flatMap((t) => taskLines(k, t, belongs, now)), '')
  }
  out.push(...decisionsLines(data, now))
  out.push('', `## 待办 ${idle.length}（开着，从没认领也没写进展）`)
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
    const [data, fromThePage, workers] = await Promise.all([boardData(team, values.project), whatThePageWrote(team, values.project), liveWorkersText(values.project)])
    process.stdout.write(indexText(data as Data, values.project ?? '看板') + '\n')
    if (workers) process.stdout.write('\n' + workers + '\n')
    if (fromThePage) process.stdout.write('\n' + fromThePage + '\n')
    return 0
  } catch (error) {
    return fail(error)
  }
}

async function liveWorkersText(project?: string): Promise<string> {
  const root = project ? await mainCheckoutRealPathOf(process.cwd()) : null
  const terminals = root ? await terminalsThatMayBeWorkers(root) : []
  if (!terminals.length) return ''
  const seen = await Promise.all((await all({ channel: project, state: 'open' })).map(seenOf))
  const keysHeldBy = (terminal: string) => seen.filter((s) => s.terminal === terminal).map((s) => s.task.labels.key ?? `#${s.task.id}`)
  const workers = terminals.filter((t) => t.inAWorktree || keysHeldBy(t.address).length)
  if (!workers.length) return ''
  return [`## 活着的 worker ${workers.length}`, ...workers.map((w) => `- ${[w.address, w.name, ...keysHeldBy(w.address)].filter(Boolean).join(' ')}`)].join('\n')
}

const answeredSeen = (a: Pick<WebAnswer, 'message'>) => `答 ${a.message}`
const inboxSeen = (i: Pick<InboxItem, 'id'>) => `收 ${i.id}`

export function inboxLine(
  items: { id: string; title: string }[],
  shownLast: string[] | null,
  page: { answered: Pick<WebAnswer, 'task' | 'message'>[]; inbox: Pick<InboxItem, 'id'>[] } = { answered: [], inbox: [] },
): string | null {
  const alreadySaidNothingWaits = !!shownLast && !shownLast.length
  if (!items.length && !page.inbox.length) return alreadySaidNothingWaits ? null : '待决 0 件'
  const seen = [...items.map((i) => i.id), ...page.answered.map(answeredSeen), ...page.inbox.map(inboxSeen)]
  const head = `待决 ${items.length} 件${page.answered.length ? `，网页已答 ${page.answered.length} 件` : ''}`
  const inbox = page.inbox.length ? `；收件箱 ${page.inbox.length} 条` : ''
  const sameSetAsShownLast = !!shownLast && shownLast.length === seen.length && seen.every((id) => shownLast.includes(id))
  if (sameSetAsShownLast) return `${head}${inbox}（无变化）`
  const answeredTasks = new Set(page.answered.map((a) => a.task))
  const freshlyAnswered = new Set(page.answered.filter((a) => !shownLast?.includes(answeredSeen(a))).map((a) => a.task))
  const fresh = items.filter((i) => !shownLast?.includes(i.id) || freshlyAnswered.has(i.id))
  const shown = fresh.length ? fresh : items
  const listed = short(shown.map((i) => `${i.id} ${short(i.title, INBOX_TITLE_WIDTH)}${answeredTasks.has(i.id) ? '（网页已答）' : ''}`).join(' · '), INBOX_LINE_WIDTH)
  return `${head}${listed ? `：${listed}` : ''}${inbox}｜说「同步」看待决`
}

async function whatThePageWrote(team: Team, project?: string) {
  if (!project) return ''
  const [answers, items] = await Promise.all([webAnswers(team, project), openInboxItems(team, project)])
  return pageText(answers, items, project)
}

export function stillOpenLine(answers: Pick<WebAnswer, 'task'>[], items: Pick<InboxItem, 'id'>[], project: string): string {
  if (!answers.length && !items.length) return ''
  const parts = [
    answers.length ? `网页已答 ${answers.length} 件（${answers.map((a) => a.task).join('、')}）` : '',
    items.length ? `收件箱 ${items.length} 条（${items.map((i) => i.id).join('、')}）` : '',
  ].filter(Boolean)
  return `${parts.join('，')}上次已给过全文，还开着；要全文跑 node <插件>/board/src/cli.ts page --project ${project}`
}

async function whatThisSessionHasNotSeen(team: Team, project: string, dir: string, session: string) {
  const [answers, items] = await Promise.all([webAnswers(team, project), openInboxItems(team, project)])
  const file = join(dir, 'page', `shown-${session.replace(/[^\w-]/g, '_')}.json`)
  const shownLast = await readFile(file, 'utf8').then((s) => JSON.parse(s) as unknown).catch(() => null)
  const shown = new Set(Array.isArray(shownLast) ? shownLast : [])
  const fresh = (seen: string) => !shown.has(seen)
  const text = [
    pageText(answers.filter((a) => fresh(answeredSeen(a))), items.filter((i) => fresh(inboxSeen(i))), project),
    stillOpenLine(answers.filter((a) => !fresh(answeredSeen(a))), items.filter((i) => !fresh(inboxSeen(i))), project),
  ].filter(Boolean).join('\n\n')
  const remember = () => mkdir(join(dir, 'page'), { recursive: true })
    .then(() => writeWholeSoAReaderNeverSeesHalf(file, JSON.stringify([...answers.map(answeredSeen), ...items.map(inboxSeen)])))
    .catch(() => undefined)
  return { text, remember }
}

export async function page(argv: string[], team: Team, dir: string): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { project: { type: 'string' }, session: { type: 'string' } } })
    if (!values.project) throw new Refused('usage: nawaban page --project <p> [--session <id>]', 2)
    if (!values.session) {
      const text = await whatThePageWrote(team, values.project)
      if (text) process.stdout.write(text + '\n')
      return 0
    }
    const { text, remember } = await whatThisSessionHasNotSeen(team, values.project, dir, values.session)
    if (text) process.stdout.write(text + '\n')
    await remember()
    return 0
  } catch (error) {
    return fail(error)
  }
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
    const [answered, open] = values.project ? await Promise.all([webAnswers(team, values.project), openInboxItems(team, values.project)]) : [[], []]
    const file = join(dir, 'inbox', `seen-${(stop.session_id || 'x').replace(/[^\w-]/g, '_')}.json`)
    const shownLast = await readFile(file, 'utf8').then((s) => JSON.parse(s) as unknown, () => null)
    await mkdir(join(dir, 'inbox'), { recursive: true })
    await writeWholeSoAReaderNeverSeesHalf(file, JSON.stringify([...items.map((i) => i.id), ...answered.map(answeredSeen), ...open.map(inboxSeen)]))
    const line = inboxLine(items, Array.isArray(shownLast) ? shownLast : null, { answered, inbox: open })
    const stalled = values.project ? await syncStalledNote(dir, values.project) : null
    const shown = [line, stalled].filter(Boolean).join('｜')
    if (shown) process.stdout.write(JSON.stringify({ systemMessage: shown }) + '\n')
    return 0
  } catch (error) {
    return fail(error)
  }
}
