import type { board, MessageView } from '@vercel/board'

type Person = ReturnType<typeof board>
export type KnownIssue = { number: number; state_reason?: string | null; reopens?: number }

export const HELD_FOR_A_GITHUB_ASK = 'GitHub 待决：'
const CLOSE_LEASE_S = 60
const HOLD_REASON_MAX = 200
const FINISHED = new Set(['completed', 'canceled'])
const ASK = /^\s*(?:#{1,6}\s*)?\**(?:待决|需要你定)\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]\**\s*/
const RULING = /^\s*(?:#{1,6}\s*)?\**已决\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]/
const TRAILING_NAWABAN_MARKER = /\n*<!-- nawaban (\{[^\n]*\}) -->\s*$/

export const keyOf = (channel: string, issue: number) => `${channel.toUpperCase()}-${issue}`
const issueNumberOf = (root: MessageView) => Number(root.labels.issue!.slice(root.labels.issue!.lastIndexOf('#') + 1))
const stateOf = (m: MessageView) => m.task?.state ?? 'none'
const firstLine = (text: string) => text.split('\n')[0]!

async function nativeRoot(person: Person, channel: string, issue: string) {
  const { threads } = await person.threads({ channel, label: { issue }, limit: 1 })
  return threads[0]?.message ?? null
}

async function tasksKeyed(person: Person, channel: string, key: string) {
  return (await person.tasks.list({ channel, state: 'all', label: { key } })).tasks.map((t) => t.message)
}

const unfinishedElseLatest = (tasks: MessageView[]) => tasks.find((t) => !FINISHED.has(stateOf(t))) ?? tasks.at(-1) ?? null

async function taskOfRoot(person: Person, root: MessageView, key: string) {
  const task = root.task ? root : (await person.tasks.create({ re: root.id })).task
  await person.label(task.id, { set: { key } })
  return { ...task, labels: { ...task.labels, key } }
}

async function reopenedAsANewTask(person: Person, root: MessageView, finished: MessageView, key: string) {
  const { task } = await person.tasks.create(root.channel, {
    text: `${firstLine(root.text)}（GitHub 上重开）\n${root.text.split('\n').slice(1).join('\n')}`,
    labels: { key, 'issue-root': root.id, 'reopened-from': finished.id },
  })
  if (finished.labels.key) await person.label(finished.id, { unset: ['key'] })
  return task
}

function markerOf(text: string): { kind?: unknown; body?: unknown } | null {
  const found = TRAILING_NAWABAN_MARKER.exec(text)
  try {
    return found ? JSON.parse(found[1]!) : null
  } catch {
    return null
  }
}

export function askOrRulingIn(text: string): { ask: string } | 'ruling' | null {
  const marker = markerOf(text)
  if (marker && typeof marker.body === 'string') return marker.kind === 'ask' ? { ask: marker.body } : marker.kind === 'resolve' ? 'ruling' : null
  const visible = text.replace(TRAILING_NAWABAN_MARKER, '')
  if (ASK.test(visible)) return { ask: visible.replace(ASK, '') }
  return RULING.test(visible) ? 'ruling' : null
}

export const githubAskIn = (m: MessageView) => {
  if (m.from !== 'github' || m.deleted) return null
  const said = askOrRulingIn(m.text)
  return said && said !== 'ruling' ? said.ask : null
}

export async function githubRepliesOf(person: Person, task: MessageView, own: MessageView[]) {
  const root = task.labels['issue-root']
  return root ? (await person.thread(root)).replies : own
}

export function currentGithubAsk(replies: MessageView[]): MessageView | null {
  const inGithubOrder = replies.filter((r) => r.from === 'github' && !r.deleted).sort((a, b) => Number(a.origin?.message) - Number(b.origin?.message) || (a.createdAt < b.createdAt ? -1 : 1))
  let pending: MessageView | null = null
  for (const r of inGithubOrder) {
    const said = askOrRulingIn(r.text)
    if (said === 'ruling') pending = null
    else if (said) pending = r
  }
  return pending
}

const pendingGithubAsk = (replies: MessageView[]) => {
  const asked = currentGithubAsk(replies)
  return asked ? githubAskIn(asked) : null
}

async function finishAsGithubClosedIt(person: Person, task: MessageView, closedAs: string | undefined) {
  if (FINISHED.has(stateOf(task)) || task.task?.for) return
  const heldByThisSync = task.task?.blocked?.reason.startsWith(HELD_FOR_A_GITHUB_ASK)
  if (heldByThisSync) task = await person.tasks.unblock(task.id)
  if (stateOf(task) !== 'ready') return
  if (closedAs === 'not_planned') return void (await person.tasks.cancel(task.id, 'GitHub 上按 not planned 关了'))
  const claim = await person.tasks.claim(task.id, { lease: CLOSE_LEASE_S })
  await claim.complete('GitHub 上关了')
}

async function holdWhileGithubAsks(person: Person, task: MessageView, ask: string | null) {
  const hold = task.task?.blocked
  if (ask !== null && !hold && stateOf(task) === 'ready') {
    await person.tasks.block(task.id, (HELD_FOR_A_GITHUB_ASK + firstLine(ask)).slice(0, HOLD_REASON_MAX), { kind: 'awaiting_approval' })
  }
  if (ask === null && hold?.kind === 'awaiting_approval' && hold.reason.startsWith(HELD_FOR_A_GITHUB_ASK)) await person.tasks.unblock(task.id)
}

async function theOneTaskHoldingTheKey(person: Person, root: MessageView, key: string) {
  const keyed = await tasksKeyed(person, root.channel, key)
  const current = unfinishedElseLatest(keyed)
  for (const stale of keyed) if (stale.id !== current?.id) await person.label(stale.id, { unset: ['key'] })
  return current ?? (await taskOfRoot(person, root, key))
}

async function settleRoot(person: Person, root: MessageView, issue: KnownIssue) {
  const key = keyOf(root.channel, issueNumberOf(root))
  const closedAs = issue.state_reason ?? undefined
  if (closedAs && root.labels['closed-as'] !== closedAs) await person.label(root.id, { set: { 'closed-as': closedAs } })
  let task = await theOneTaskHoldingTheKey(person, root, key)
  const issueOpen = root.labels.state !== 'closed'
  const reopensSeen = String(issue.reopens ?? 0)
  const reopenedOnGithubSinceTheTaskFinished = issueOpen && FINISHED.has(stateOf(task)) && (root.labels['reopens-settled'] ?? '0') !== reopensSeen
  if (reopenedOnGithubSinceTheTaskFinished) task = await reopenedAsANewTask(person, root, task, key)
  if (issueOpen && (root.labels['reopens-settled'] ?? '0') !== reopensSeen) await person.label(root.id, { set: { 'reopens-settled': reopensSeen } })
  const whyClosed = closedAs ?? root.labels['closed-as']
  if (!issueOpen) return issue.state_reason === undefined && whyClosed === undefined ? undefined : finishAsGithubClosedIt(person, task, whyClosed)
  await holdWhileGithubAsks(person, task, pendingGithubAsk((await person.thread(root.id)).replies))
}

export async function settleIssueTasks(person: Person, channel: string, repo: string, known: KnownIssue[]) {
  const failed: string[] = []
  for (const issue of known) {
    try {
      const root = await nativeRoot(person, channel, `${repo}#${issue.number}`)
      if (root) await settleRoot(person, root, issue)
    } catch (error) {
      failed.push(`#${issue.number}：${(error as Error).message}`)
    }
  }
  if (failed.length) throw new Error(`这些 issue 这轮没结算成，下一轮再试：${failed.join('；')}`)
}
