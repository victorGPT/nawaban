import { block, type board, type MessageView } from '@vercel/board'
import { tasksOf } from './views.ts'

type Team = ReturnType<typeof board>

export const inboxChannel = (project: string) => `inbox/${project}`
export const INBOX_OPEN = { inbox: 'open' } as const
export const INBOX_DONE = { inbox: 'done' } as const

const THREADS_PAGE = 50
const HOLDS_THE_DECISION_MAKER_ANSWERS = new Set(['needs_input', 'awaiting_approval'])
const NOTE_THAT_RAISES_A_HOLD_FOR_A_PERSON = /^\s*triage:\s*needs-info\b/

const key = (m: MessageView) => m.labels.key ?? `#${m.id}`
const author = (m: MessageView) => m.author?.name || m.author?.handle || ''
const firstBlock = (m: MessageView, schema: string) =>
  m.deleted ? undefined : (m.blocks.find((b) => b.schema === schema && b.version === 1 && b.data)?.data as Record<string, unknown> | undefined)

export type WebAnswer = { task: string; title: string; hold: string; option: string | null; words: string; by: string; at: string; message: string }
export type InboxItem = { id: string; words: string; by: string; at: string }

export const webAnswerText = (answer: { option?: string; words: string }) => block('nawaban-web-answer@1', answer)
export const inboxItemText = (words: string) => `${words.split('\n')[0]}\n\n${block('nawaban-inbox@1', { words })}`

const raisesTheHold = (m: MessageView) => !!firstBlock(m, 'nawaban-ask') || (m.blocks.length === 0 && NOTE_THAT_RAISES_A_HOLD_FOR_A_PERSON.test(m.text))

export function answerToTheCurrentHold(root: MessageView, replies: MessageView[]): WebAnswer | null {
  const hold = root.task?.blocked?.kind ?? ''
  if (!HOLDS_THE_DECISION_MAKER_ANSWERS.has(hold)) return null
  const asked = replies.findLastIndex(raisesTheHold)
  const answer = replies.slice(asked + 1).findLast((m) => firstBlock(m, 'nawaban-web-answer'))
  if (!answer) return null
  const d = firstBlock(answer, 'nawaban-web-answer')!
  return {
    task: key(root),
    title: root.text.split('\n')[0]!,
    hold,
    option: d.option == null ? null : String(d.option),
    words: String(d.words),
    by: author(answer),
    at: answer.createdAt,
    message: answer.id,
  }
}

export async function webAnswers(team: Team, project?: string): Promise<WebAnswer[]> {
  const held = (await tasksOf(team, project, 'blocked')).filter((m) => HOLDS_THE_DECISION_MAKER_ANSWERS.has(m.task?.blocked?.kind ?? ''))
  const threads = await Promise.all(held.map((m) => team.thread(m.id)))
  return threads.flatMap(({ message, replies }) => answerToTheCurrentHold(message, replies) ?? [])
}

export async function openInboxItems(team: Team, project: string): Promise<InboxItem[]> {
  const out: InboxItem[] = []
  for (let page = await team.threads({ channel: inboxChannel(project), label: INBOX_OPEN, limit: THREADS_PAGE }); ; page = await team.threads({ channel: inboxChannel(project), label: INBOX_OPEN, limit: THREADS_PAGE, before: page.older! })) {
    for (const { message: m } of page.threads) {
      if (m.deleted) continue
      out.push({ id: m.id, words: String(firstBlock(m, 'nawaban-inbox')?.words ?? m.text.split('\n')[0]), by: author(m), at: m.createdAt })
    }
    if (!page.older) return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  }
}

export function pageText(answers: WebAnswer[], items: InboxItem[], project: string): string {
  const out = []
  if (answers.length) {
    out.push(`## 网页已答 ${answers.length}（还挂着；核实后 nawaban event <号> --kind resolve --body "<原话>" 记已决，等你的改记 --kind decision --by user 再 triage: ready-for-agent）`)
    for (const a of answers) out.push(`- ${a.task} ${a.title}：${a.option ? `选「${a.option}」，` : ''}${a.words}${a.by ? `（${a.by}）` : ''}`)
  }
  if (items.length) {
    if (out.length) out.push('')
    out.push(
      `## 收件箱 ${items.length}（${inboxChannel(project)} 里开着的；转任务：nawaban create <KEY> --project ${project} --title … --body "…（收件箱 #<id>）"，再 nawaban label <id> inbox=done task=<KEY> --if inbox=open；转命令或不做：nawaban label <id> inbox=done --if inbox=open）`,
    )
    for (const i of items) out.push(`- #${i.id} ${i.words}`)
  }
  return out.join('\n')
}
