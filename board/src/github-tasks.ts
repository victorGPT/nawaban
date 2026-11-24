import type { board, MessageView } from '@vercel/board'

type Person = ReturnType<typeof board>
export type KnownIssue = { number: number; state_reason?: string | null }

export const HELD_FOR_A_GITHUB_ASK = 'GitHub 待决：'
const CLOSE_LEASE_S = 60
const HOLD_REASON_MAX = 200
const FINISHED = new Set(['completed', 'canceled'])
const ASK = /^\s*(?:#{1,6}\s*)?\**(?:待决|需要你定)\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]\**\s*/
const RULING = /^\s*(?:#{1,6}\s*)?\**已决\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]/

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

function pendingGithubAsk(replies: MessageView[]) {
  const inGithubOrder = replies.filter((r) => r.from === 'github' && !r.deleted).sort((a, b) => Number(a.origin?.message) - Number(b.origin?.message) || (a.createdAt < b.createdAt ? -1 : 1))
  let pending: string | null = null
  for (const r of inGithubOrder) {
    if (ASK.test(r.text)) pending = r.text.replace(ASK, '')
    else if (RULING.test(r.text)) pending = null
  }
  return pending
}

async function finishAsGithubClosedIt(person: Person, task: MessageView, closedAs: string | undefined) {
  if (FINISHED.has(stateOf(task))) return
  if (closedAs === 'not_planned') return void (await person.tasks.cancel(task.id, 'GitHub 上按 not planned 关了'))
  const heldByThisSync = task.task?.blocked?.reason.startsWith(HELD_FOR_A_GITHUB_ASK)
  if (heldByThisSync) task = await person.tasks.unblock(task.id)
  if (stateOf(task) !== 'ready') return
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

async function settleRoot(person: Person, root: MessageView, closedAs: string | undefined) {
  const key = keyOf(root.channel, issueNumberOf(root))
  if (closedAs && root.labels['closed-as'] !== closedAs) await person.label(root.id, { set: { 'closed-as': closedAs } })
  let task = unfinishedElseLatest(await tasksKeyed(person, root.channel, key)) ?? (await taskOfRoot(person, root, key))
  const issueOpen = root.labels.state !== 'closed'
  if (issueOpen && FINISHED.has(stateOf(task))) task = await reopenedAsANewTask(person, root, task, key)
  if (!issueOpen) return finishAsGithubClosedIt(person, task, closedAs ?? root.labels['closed-as'])
  await holdWhileGithubAsks(person, task, pendingGithubAsk((await person.thread(root.id)).replies))
}

export async function settleIssueTasks(person: Person, channel: string, repo: string, known: KnownIssue[]) {
  for (const issue of known) {
    const root = await nativeRoot(person, channel, `${repo}#${issue.number}`)
    if (root) await settleRoot(person, root, issue.state_reason ?? undefined)
  }
}
