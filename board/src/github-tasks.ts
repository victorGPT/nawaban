import { createHash } from 'node:crypto'
import { block, BoardError, type board, type MessageView } from '@vercel/board'

type Person = ReturnType<typeof board>
export type KnownIssue = { number: number; title?: string; state_reason?: string | null; reopens?: number }

export const HELD_FOR_A_GITHUB_ASK = 'GitHub 待决：'
export const TITLE_AWAITS_GITHUB = 'title-awaits-github'
export type EditRoot = (root: MessageView, text: string) => Promise<unknown>
const CLOSE_LEASE_S = 60
const HOLD_REASON_MAX = 200
const FINISHED = new Set(['completed', 'canceled'])
const ASK = /^\s*(?:#{1,6}\s*)?\**(?:待决|需要你定)\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]\**\s*/
const RULING = /^\s*(?:#{1,6}\s*)?\**已决\**\s*(?:[（(][^）)\n]*[）)])?\**\s*[：:]/
const KR_SAID_ON_GITHUB = /^(.+)=([↑↓=])(?:\s+(-?\d+(?:\.\d+)?%?)\s*→\s*(-?\d+(?:\.\d+)?%?)\s+(实测|预计))?$/
const KR_HEADING_SAID_ON_GITHUB = /^(.+)=(toward|away|hold)$/
const OBJECTIVE_SAID_ON_GITHUB = /^O (.+)$/
const TRAILING_NAWABAN_MARKER = /\n*<!-- nawaban (\{[^\n]*\}) -->\s*$/

export const keyOf = (channel: string, issue: number) => `${channel.toUpperCase()}-${issue}`
const issueNumberOf = (root: MessageView) => Number(root.labels.issue!.slice(root.labels.issue!.lastIndexOf('#') + 1))
export const githubIssueOfTask = (task: MessageView) =>
  task.labels.issue ? issueNumberOf(task) : task.labels['issue-root'] && task.labels.key ? Number(task.labels.key.slice(task.labels.key.lastIndexOf('-') + 1)) : null
const stateOf = (m: MessageView) => m.task?.state ?? 'none'
const firstLine = (text: string) => text.split('\n')[0]!

async function titledFromGithub(person: Person, root: MessageView, title: string, editRoot: EditRoot) {
  const text = [title, ...root.text.split('\n').slice(1)].join('\n')
  await editRoot(root, text)
  await person.label(root.id, { unset: [TITLE_AWAITS_GITHUB] })
  const { [TITLE_AWAITS_GITHUB]: _, ...labels } = root.labels
  return { ...root, text, labels }
}

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

export const PUSHED_AS = 'github-comment'

export const inGithubFormat = (m: MessageView) => m.from === 'github' || (m.from === null && TRAILING_NAWABAN_MARKER.test(m.text))

const githubCommentIdOf = (m: MessageView) => Number(m.from === 'github' ? m.origin?.message : (m.labels[PUSHED_AS] ?? Infinity))

export const inGithubOrder = (a: MessageView, b: MessageView) => {
  const [x, y] = [githubCommentIdOf(a), githubCommentIdOf(b)]
  return x !== y ? (x < y ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1
}

export function markerOf(text: string): { kind?: unknown; body?: unknown; uid?: unknown; change?: unknown } | null {
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
  if (!inGithubFormat(m) || m.deleted) return null
  const said = askOrRulingIn(m.text)
  return said && said !== 'ruling' ? said.ask : null
}

export async function githubRepliesOf(person: Person, task: MessageView, own: MessageView[]) {
  const root = task.labels['issue-root']
  return root ? (await person.thread(root)).replies : own
}

const askOrRulingOnTheBoard = (m: MessageView): { ask: string } | 'ruling' | null =>
  m.blocks.some((b) => b.schema === 'nawaban-resolve') ? 'ruling' : m.blocks.some((b) => b.schema === 'nawaban-ask') ? { ask: '' } : null

function inOneOrderWithWhatIsNotOnGithubYet(replies: MessageView[]) {
  const onGithub = replies.filter((m) => Number.isFinite(githubCommentIdOf(m)))
  const place = (m: MessageView) => {
    const id = githubCommentIdOf(m)
    if (Number.isFinite(id)) return id
    const seenBefore = onGithub.filter((g) => g.createdAt <= m.createdAt).map(githubCommentIdOf)
    return Math.max(0, ...seenBefore) + 0.5
  }
  return [...replies].sort((a, b) => place(a) - place(b) || (a.createdAt < b.createdAt ? -1 : 1))
}

export function currentGithubAsk(replies: MessageView[]): MessageView | null {
  let pending: MessageView | null = null
  for (const r of inOneOrderWithWhatIsNotOnGithubYet(replies.filter((m) => !m.deleted))) {
    const said = inGithubFormat(r) ? askOrRulingIn(r.text) : r.from === null ? askOrRulingOnTheBoard(r) : null
    if (said === 'ruling') pending = null
    else if (said) pending = r
  }
  return pending
}

const pendingGithubAsk = (replies: MessageView[]) => {
  const asked = currentGithubAsk(replies)
  return asked ? githubAskIn(asked) : null
}

async function finishAsClosed(person: Person, task: MessageView, closedAs: string | undefined, where = 'GitHub 上') {
  if (FINISHED.has(stateOf(task)) || task.task?.for) return
  const heldByThisSync = task.task?.blocked?.reason.startsWith(HELD_FOR_A_GITHUB_ASK)
  if (heldByThisSync) task = await person.tasks.unblock(task.id)
  if (stateOf(task) !== 'ready') return
  if (closedAs === 'not_planned') return void (await person.tasks.cancel(task.id, `${where}按 not planned 关了`))
  const claim = await person.tasks.claim(task.id, { lease: CLOSE_LEASE_S })
  await claim.complete(`${where}关了`)
}

export async function closeTaskOfRootHere(person: Person, root: MessageView, closedAs: string) {
  const task = unfinishedElseLatest(await tasksKeyed(person, root.channel, keyOf(root.channel, issueNumberOf(root))))
  if (task) await finishAsClosed(person, task, closedAs, '本地')
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

function declarationSaidOnGithub(said: string, change: unknown) {
  const [head, ...krs] = said.split(' · ').map((part) => part.trim())
  const objective = OBJECTIVE_SAID_ON_GITHUB.exec(head!)?.[1]
  const headings = krs.map((kr) => KR_HEADING_SAID_ON_GITHUB.exec(kr))
  if (objective && krs.length && headings.every(Boolean)) {
    return block('nawaban-impact@2', { objective, change: typeof change === 'string' ? change : 'product', krs: headings.map((kr) => ({ name: kr![1], heading: kr![2] })) })
  }
  const parsed = krs.map((kr) => KR_SAID_ON_GITHUB.exec(kr))
  if (!objective || parsed.some((kr) => !kr)) throw new Error(`GitHub 上的影响评论读不懂：${said}`)
  return block('nawaban-impact@1', {
    objective,
    krs: parsed.map((kr) => Object.fromEntries(Object.entries({ name: kr![1], dir: kr![2], before: kr![3], after: kr![4], basis: kr![5] }).filter(([, v]) => v !== undefined))),
  })
}

const DECLARES_WHAT_GITHUB_SAID_IN = 'github-impact-of'
const declarationIdOf = (githubReply: MessageView, made: number) => 'github-impact-' + createHash('sha256').update(`${githubReply.id}\0${made}`).digest('hex').slice(0, 32)

export async function repliesOnTheIssue(person: Pick<Person, 'tasks' | 'thread'>, channel: string, root: MessageView) {
  const reopened = (await person.tasks.list({ channel, state: 'all', label: { 'issue-root': root.id } })).tasks.map((t) => t.message)
  return (await Promise.all([root, ...reopened].map((m) => person.thread(m.id)))).flatMap((t) => t.replies)
}

const impactSaidIn = (githubReply: MessageView) => {
  const marker = githubReply.deleted ? null : markerOf(githubReply.text)
  return marker?.kind === 'impact' && typeof marker.body === 'string' ? declarationSaidOnGithub(marker.body, marker.change) : null
}

const everPosted = (person: Person, id: string) =>
  person.posted(id).then(
    () => true,
    (error) => {
      if (error instanceof BoardError && error.code === 'post_not_found') return false
      throw error
    },
  )

async function unusedDeclarationIdOf(person: Person, githubReply: MessageView) {
  let made = 0
  while (await everPosted(person, declarationIdOf(githubReply, made))) made++
  return declarationIdOf(githubReply, made)
}

async function declareWhatGithubDeclared(person: Person, root: MessageView, replies: MessageView[]) {
  for (const r of replies.filter((m) => m.from === 'github').sort(inGithubOrder)) {
    const said = impactSaidIn(r)
    const live = replies.filter((m) => !m.deleted && m.labels[DECLARES_WHAT_GITHUB_SAID_IN] === r.id)
    const kept = said === null ? undefined : live.find((m) => m.text === said)
    for (const stale of live.filter((m) => m !== kept)) await person.delete(stale.id)
    if (said !== null && !kept) await person.reply(root.id, { id: await unusedDeclarationIdOf(person, r), text: said, labels: { [DECLARES_WHAT_GITHUB_SAID_IN]: r.id } })
  }
}

async function settleRoot(person: Person, root: MessageView, issue: KnownIssue, editRoot: EditRoot) {
  if (root.labels[TITLE_AWAITS_GITHUB] && issue.title !== undefined) root = await titledFromGithub(person, root, issue.title, editRoot)
  const key = keyOf(root.channel, issueNumberOf(root))
  const closedAs = issue.state_reason ?? undefined
  if (closedAs && root.labels['closed-as'] !== closedAs) await person.label(root.id, { set: { 'closed-as': closedAs } })
  let task = await theOneTaskHoldingTheKey(person, root, key)
  const { replies } = await person.thread(root.id)
  await declareWhatGithubDeclared(person, root, replies)
  const issueOpen = root.labels.state !== 'closed'
  const reopensSeen = String(issue.reopens ?? 0)
  const reopenedOnGithubSinceTheTaskFinished = issueOpen && FINISHED.has(stateOf(task)) && (root.labels['reopens-settled'] ?? '0') !== reopensSeen
  if (reopenedOnGithubSinceTheTaskFinished) task = await reopenedAsANewTask(person, root, task, key)
  if (issueOpen && (root.labels['reopens-settled'] ?? '0') !== reopensSeen) await person.label(root.id, { set: { 'reopens-settled': reopensSeen } })
  const whyClosed = closedAs ?? root.labels['closed-as']
  if (!issueOpen) return issue.state_reason === undefined && whyClosed === undefined ? undefined : finishAsClosed(person, task, whyClosed)
  await holdWhileGithubAsks(person, task, pendingGithubAsk(task.id === root.id ? replies : await repliesOnTheIssue(person, root.channel, root)))
}

export async function openIssuesWithoutAnOpenTask(person: Person, channel: string, issues: number[]) {
  const missing: number[] = []
  for (const issue of issues) {
    const task = unfinishedElseLatest(await tasksKeyed(person, channel, keyOf(channel, issue)))
    if (!task || FINISHED.has(stateOf(task))) missing.push(issue)
  }
  return missing
}

export async function settleIssueTasks(person: Person, channel: string, repo: string, known: KnownIssue[], editRoot: EditRoot = (root, text) => person.edit(root.id, text)) {
  const failed: string[] = []
  for (const issue of known) {
    try {
      const root = await nativeRoot(person, channel, `${repo}#${issue.number}`)
      if (root) await settleRoot(person, root, issue, editRoot)
    } catch (error) {
      failed.push(`#${issue.number}：${(error as Error).message}`)
    }
  }
  if (failed.length) throw new Error(`这些 issue 这轮没结算成，下一轮再试：${failed.join('；')}`)
}
