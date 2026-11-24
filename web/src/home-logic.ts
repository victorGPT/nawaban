import { allOf, cardSignal, taskGroups, waitsOnYou, type Agent, type Board, type BoardTask, type Harness, type Item } from './logic'

export const HARNESS_NAMES: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' }
const HARNESS_LETTERS: Record<Harness, string> = { claude: 'C', codex: 'X', agy: 'A' }
const UNKNOWN_AGENT = { letter: '?', name: '未知' }
const ROWS_SHOWN_PER_FEED = 8

type AgentDetail = 'model' | 'worker'

export const agentLetter = (agent: Agent | null) => (agent ? HARNESS_LETTERS[agent.harness] : UNKNOWN_AGENT.letter)

export const agentLine = (agent: Agent | null, ...details: AgentDetail[]) =>
  agent ? [HARNESS_NAMES[agent.harness], ...details.map((d) => agent[d])].filter(Boolean).join(' · ') : UNKNOWN_AGENT.name

const firstLine = (text: string) => text.trim().split('\n')[0]!.trim()

export type Ask = 'approve' | 'question'
export const ASK_WORDS: Record<Ask, string> = { approve: '要批', question: '问你' }
export type WaitingCard = { id: string; agent: Agent | null; ask: Ask; question: string; answerable: boolean; since: number }

const waitingCardOf = (t: BoardTask): WaitingCard => ({
  id: t.id,
  agent: t.agent ?? null,
  ask: t.pending ? 'approve' : 'question',
  question: firstLine(t.pending ? (t.pending.card?.decision ?? t.pending.brief ?? t.waiting ?? '') : (t.waiting ?? '')),
  answerable: !!(t.pending?.card && t.pending.ask),
  since: t.pending?.at ?? t.active_at,
})

export const waitingOnYou = (board: Board | null) =>
  allOf(board)
    .filter(waitsOnYou)
    .map(waitingCardOf)
    .sort((x, y) => x.since - y.since || (x.id < y.id ? -1 : 1))

export type Push = 'blocked' | 'moving' | 'idle'
const PUSHES_IN_ORDER: Push[] = ['blocked', 'moving', 'idle']
const PUSH_WORDS: Record<Exclude<Push, 'idle'>, string> = { blocked: '卡在你', moving: '在推' }
export type PushedThread = { id: string; title: string; push: Push; word: string; note: string | null; agent: Agent | null }

const pushOf = (item: Item): Push => (item.waiting ? 'blocked' : item.state === 'working' ? 'moving' : 'idle')

const pushedThreadOf = (item: Item, now: number): PushedThread => {
  const push = pushOf(item)
  return {
    id: item.id,
    title: item.title,
    push,
    word: push === 'idle' ? cardSignal(item, now)! : PUSH_WORDS[push],
    note: item.note ? firstLine(item.note) : null,
    agent: item.agent,
  }
}

export const pushedThreads = (board: Board | null, now: number) =>
  taskGroups(board, now)
    .flatMap((g) => g.items)
    .filter((x) => x.state === 'working' || x.state === 'stopped')
    .map((x) => pushedThreadOf(x, now))
    .sort((x, y) => PUSHES_IN_ORDER.indexOf(x.push) - PUSHES_IN_ORDER.indexOf(y.push))

export type Move = { at: number; task: string; text: string }
export type Happening = Move & { agent: Agent | null }

const localMidnightOf = (now: number) => new Date(now * 1000).setHours(0, 0, 0, 0) / 1000
const doneWords = (t: BoardTask) => '完成：' + t.title
const latestFirst = <T extends Move>(rows: T[]) => rows.sort((x, y) => y.at - x.at).slice(0, ROWS_SHOWN_PER_FEED)

export function todaysMoves(board: Board | null, now: number): Move[] {
  const since = localMidnightOf(now)
  const closed = allOf(board).flatMap((t) => (t.status === 'done' && (t.done_at ?? 0) >= since ? [{ at: t.done_at!, task: t.id, text: doneWords(t) }] : []))
  const ruled = (board?.decisions ?? []).flatMap((d) => (d.owner && d.at >= since ? [{ at: d.at, task: d.task, text: '决定：' + firstLine(d.verdict) }] : []))
  return latestFirst([...closed, ...ruled])
}

export const justHappened = (board: Board | null): Happening[] =>
  latestFirst(
    allOf(board).flatMap((t) => [
      ...(t.progress ? [{ at: t.progress.at, task: t.id, text: firstLine(t.progress.body), agent: t.agent ?? null }] : []),
      ...(t.status === 'done' && t.done_at ? [{ at: t.done_at, task: t.id, text: doneWords(t), agent: t.agent ?? null }] : []),
    ]),
  )
