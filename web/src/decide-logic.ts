export type Option = { key: string; text: string; note: string }
export type Card = { decision: string; kr: string; context: string; options: Option[]; rec: string }
export type Pending = { at: number; card: Card | null; ask: string | null; brief?: string }
type HeldTask = { id: string; title: string; status: string; pending?: Pending | null }
export type DecideBoard = { columns: { key: string; tasks: HeldTask[] }[] }
export type WebAnswer = { task: string; option: string | null; words: string; at: string }
export type Reply = { option?: string; words: string }
export type DecisionCard = Card & { id: string; at: number; ask: string; handed: WebAnswer | null; headline: string; more: string }

export const REPLIES = {
  pick: (option: string): Reply => ({ option, words: '就这么定' }),
  unclear: { words: '背景不够，请补写后重发待决' },
  decided: { words: '已定，请核实后记已决（决策记录）' },
} as const

export function decisionCards(board: DecideBoard | null, answers: WebAnswer[]): DecisionCard[] {
  const answered = new Map(answers.map((a) => [a.task, a]))
  return heldCards(board)
    .map((c) => ({ ...c, ...headlineAndMore(c.decision), options: c.options.map((o) => ({ ...o, note: doorsInChinese(o.note) })), handed: answered.get(c.id) ?? null }))
    .sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : 1))
}

const DOOR_NAMES: Record<string, string> = { 'one-way': '单向门', 'two-way': '双向门' }

const doorsInChinese = (note: string) =>
  note
    .split('｜')
    .map((part) => DOOR_NAMES[part.trim()] ?? part)
    .join('｜')

const headlineAndMore = (decision: string) => {
  const [headline, ...more] = decision.split('\n')
  return { headline, more: more.join('\n').trim() }
}

const heldCards = (board: DecideBoard | null) =>
  (board?.columns ?? []).flatMap((c) => c.tasks).flatMap((t) => (t.status !== 'done' && t.pending?.card && t.pending.ask ? [{ ...t.pending.card, id: t.id, at: t.pending.at, ask: t.pending.ask }] : []))

export type FetchedAnswers = { board: DecideBoard | null; answers: WebAnswer[] }

export function answersStillAbout(board: DecideBoard | null, fetched: FetchedAnswers): WebAnswer[] {
  if (fetched.board === board) return fetched.answers
  const cardsOf = (b: DecideBoard | null) => new Map(heldCards(b).map((c) => [c.id, JSON.stringify(c)]))
  const then = cardsOf(fetched.board)
  const now = cardsOf(board)
  return fetched.answers.filter((a) => then.has(a.task) && then.get(a.task) === now.get(a.task))
}

export const handedText = (a: WebAnswer) => `已交编排者：${a.option ? `选「${a.option}」，` : ''}${a.words}`
