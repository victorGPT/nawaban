import { block, BoardError, type board, type MessageView } from '@vercel/board'
import { currentGithubAsk, githubRepliesOf, HELD_FOR_A_GITHUB_ASK } from './github-tasks.ts'
import { Refused } from './tasks.ts'
import { tasksOf } from './views.ts'

type Team = ReturnType<typeof board>

export const inboxChannel = (project: string) => `inbox/${project}`
export const INBOX_OPEN = { inbox: 'open' } as const
export const INBOX_DONE = { inbox: 'done' } as const

const THREADS_PAGE = 50
const HOLDS_THE_DECISION_MAKER_ANSWERS = new Set(['needs_input', 'awaiting_approval'])
const NOTE_THAT_RAISES_OR_ENDS_A_HOLD_FOR_A_PERSON = /^\s*triage:\s*(?:needs-info|ready-for-agent)\b/

const key = (m: MessageView) => m.labels.key ?? `#${m.id}`
const author = (m: MessageView) => m.author?.name || m.author?.handle || ''
const firstBlock = (m: MessageView, schema: string) =>
  m.deleted ? undefined : (m.blocks.find((b) => b.schema === schema && b.version === 1 && b.data)?.data as Record<string, unknown> | undefined)

export type WebAnswer = { task: string; title: string; hold: string; option: string | null; words: string; by: string; at: string; message: string }
export type InboxItem = { id: string; words: string; by: string; at: string }
export type InboxEntry = { id: string; words: string; at: string; done: boolean; task: string | null }

export const INBOX_WORDS_MAX = 2000
const INBOX_CHANNEL_PREFIX = inboxChannel('')

export const ANSWERS_LABEL = 'answers'
export const webAnswerText = (answer: { option?: string; words: string }) => block('nawaban-web-answer@1', answer)
const FENCE_THAT_WOULD_SWALLOW_THE_BLOCK = /^[\s`~]+/
const summaryLineThatOpensNoFence = (words: string) => words.split('\n')[0]!.replace(FENCE_THAT_WOULD_SWALLOW_THE_BLOCK, '').trim() || '…'
export const inboxItemText = (words: string) => `${summaryLineThatOpensNoFence(words)}\n\n${block('nawaban-inbox@1', { words })}`

const startsOrEndsAHold = (m: MessageView) =>
  !!firstBlock(m, 'nawaban-ask') || !!firstBlock(m, 'nawaban-resolve') || (m.blocks.length === 0 && NOTE_THAT_RAISES_OR_ENDS_A_HOLD_FOR_A_PERSON.test(m.text))

export function answerToTheCurrentHold(root: MessageView, replies: MessageView[], githubReplies = replies): WebAnswer | null {
  const hold = root.task?.blocked?.kind ?? ''
  if (!HOLDS_THE_DECISION_MAKER_ANSWERS.has(hold)) return null
  const heldForAGithubAsk = root.task?.blocked?.reason.startsWith(HELD_FOR_A_GITHUB_ASK) ?? false
  const githubAsk = heldForAGithubAsk ? currentGithubAsk(githubReplies) : null
  const asked = replies.findLastIndex(startsOrEndsAHold)
  const answer = heldForAGithubAsk
    ? githubAsk && replies.findLast((m) => firstBlock(m, 'nawaban-web-answer') && m.labels[ANSWERS_LABEL] === githubAsk.id)
    : replies.slice(asked + 1).findLast((m) => firstBlock(m, 'nawaban-web-answer'))
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
  const threads = await Promise.all(held.map(async (m) => {
    const { message, replies } = await team.thread(m.id)
    return { message, replies, githubReplies: await githubRepliesOf(team, message, replies) }
  }))
  return threads.flatMap(({ message, replies, githubReplies }) => answerToTheCurrentHold(message, replies, githubReplies) ?? [])
}

async function inboxRoots(team: Team, project: string, label?: Record<string, string>) {
  const query = { channel: inboxChannel(project), label, limit: THREADS_PAGE }
  const roots: MessageView[] = []
  for (let page = await team.threads(query); ; page = await team.threads({ ...query, before: page.older! })) {
    roots.push(...page.threads.map((t) => t.message).filter((m) => !m.deleted))
    if (!page.older) return roots
  }
}

const wordsOf = (m: MessageView) => String(firstBlock(m, 'nawaban-inbox')?.words ?? m.text.split('\n')[0])
const oldestFirst = (a: { at: string }, b: { at: string }) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)

export async function openInboxItems(team: Team, project: string): Promise<InboxItem[]> {
  return (await inboxRoots(team, project, INBOX_OPEN)).map((m) => ({ id: m.id, words: wordsOf(m), by: author(m), at: m.createdAt })).sort(oldestFirst)
}

const entryOf = (m: MessageView): InboxEntry => ({ id: m.id, words: wordsOf(m), at: m.createdAt, done: m.labels.inbox === 'done', task: m.labels.task ?? null })

export async function inboxEntries(team: Team, project: string): Promise<InboxEntry[]> {
  const entries = (await inboxRoots(team, project)).filter((m) => firstBlock(m, 'nawaban-inbox')).map(entryOf).sort(oldestFirst).reverse()
  return [...entries.filter((e) => !e.done), ...entries.filter((e) => e.done)]
}

export async function keepInboxItem(team: Team, project: string, words: string): Promise<InboxEntry> {
  if (!project || project.includes('/')) throw new Refused('project must be a project name')
  const kept = words.trim()
  if (!kept) throw new Refused('nothing to keep')
  if (kept.length > INBOX_WORDS_MAX) throw new Refused(`at most ${INBOX_WORDS_MAX} characters`)
  try {
    return entryOf(await team.post(inboxChannel(project), { text: inboxItemText(kept), labels: INBOX_OPEN }))
  } catch (error) {
    const boardRefusedWhatWasSent = error instanceof BoardError && error.status >= 400 && error.status < 500
    if (boardRefusedWhatWasSent) throw new Refused(error.message)
    throw error
  }
}

export async function dropInboxItem(team: Team, id: string) {
  const root = await team.thread(id).then(({ message }) => message, () => null)
  const anInboxItem = root?.id === id && !root.deleted && root.channel.startsWith(INBOX_CHANNEL_PREFIX) && firstBlock(root, 'nawaban-inbox')
  if (!anInboxItem) return false
  await team.delete(id)
  return true
}

export function pageText(answers: WebAnswer[], items: InboxItem[], project: string): string {
  const out = []
  if (answers.length) {
    out.push(`## 网页已答 ${answers.length}（还挂着；以下命令都是 node <插件>/board/src/cli.ts；核实后 nawaban event <号> resolve "<原话>" 记已决，等你的改记 nawaban event <号> decision "<决策记录>" --by user 再 nawaban event <号> note "triage: ready-for-agent"）`)
    for (const a of answers) out.push(`- ${a.task} ${a.title}：${a.option ? `选「${a.option}」，` : ''}${a.words}${a.by ? `（${a.by}）` : ''}`)
  }
  if (items.length) {
    if (out.length) out.push('')
    out.push(
      `## 收件箱 ${items.length}（${inboxChannel(project)} 里开着的，行首是条目 id；命令都是 node <插件>/board/src/cli.ts；转任务：nawaban create <KEY> --project ${project} --title … "…（收件箱 <id>）"，再 nawaban board label <id> inbox=done task=<KEY> --if inbox=open；转命令或不做：nawaban board label <id> inbox=done --if inbox=open）`,
    )
    for (const i of items) out.push(`- ${i.id} ${i.words}`)
  }
  return out.join('\n')
}
