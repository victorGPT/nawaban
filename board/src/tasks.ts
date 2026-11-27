import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { text } from 'node:stream/consumers'
import { userInfo } from 'node:os'
import { block as blockOf, board, type MessageView } from '@vercel/board'
import { createApp } from '@vercel/board/cli'
import { answer, upstreamAnswer, orRefusal, Refused, type Said } from './said.ts'
import { projectOfThisRepository, RESULT_FORMAT, undeclared } from './impact.ts'
import { boardDirAsConfiguredWhenAsked } from './server.ts'
import { UNMEASURED } from './schemas.ts'
import { labelsOfLive, LIVE_LABELS, liveOfLabels, type Held, type Live } from './progress.ts'
import { optionWordsBut, pointAt, withBody } from './hint.ts'
import { markInboxItemTurnedInto, openInboxItem } from './page.ts'
import { EVENTS_THAT_END_A_CLAIM } from './views.ts'
import { refuseAClaimGithubAssignedToSomeoneElse, sayOnGithubToo, wantStateOnGithubToo } from './github-push.ts'

const LEASE = '1h'
const PAGE = 50
const PROFILE_NAME = /^[A-Za-z][A-Za-z0-9-]{0,31}$/
const SESSION_PREFIX_LENGTH = 8
export const BODY_FROM_STDIN = '-'
const NEWLINE_A_FILE_ENDS_WITH_AS_BOARD_REPLY_DROPS_IT = /\n$/
const personOwningEveryTaskTheirProfilesMade = () => board().as(null)
const cliWhoseClaimsTheRenewHookFinds = (argv: string[]) => createApp({ appName: 'nawaban' }).run(argv)

const boardKeepsProfileNamesLowercase = (name: string) => name.toLowerCase()

export const sessionProfile = (agent: 'cx' | 'agy' | 'cc', session: string) =>
  boardKeepsProfileNamesLowercase(`${agent}-${session.slice(0, SESSION_PREFIX_LENGTH)}`)

export function profile(): string {
  const { CODEX_THREAD_ID: codexThread, ANTIGRAVITY_CONVERSATION_ID: antigravity, CLAUDE_CODE_SESSION_ID: claudeCode, NAWABAN_OWNER: owner = '' } = process.env
  if (codexThread) return sessionProfile('cx', codexThread)
  if (antigravity) return sessionProfile('agy', antigravity)
  if (claudeCode) return sessionProfile('cc', claudeCode)
  const named = owner || userInfo().username
  if (!PROFILE_NAME.test(named)) throw new Refused(`身份 ${named} 不是身份名：字母开头，后面最多 31 个字母、数字或连字符；设 NAWABAN_OWNER`, 2)
  return boardKeepsProfileNamesLowercase(named)
}

export const key = (m: MessageView) => m.labels.key ?? m.id
const title = (m: MessageView) => m.text.split('\n')[0]
const clock = (iso: string) => new Date(iso).toTimeString().slice(0, 5)
export const live = (m: MessageView) => {
  const claim = m.task?.claim
  return claim && Date.parse(claim.until) > Date.now() ? claim : null
}
const profileViaUser = (actor: string) => {
  const [who, as] = actor.slice(actor.lastIndexOf(':') + 1).split('+')
  return as ? `${as} via ${who}` : who
}
export const state = (m: MessageView) => (m.task?.state === 'claimed' && !live(m) ? 'ready' : m.task?.state ?? 'not a task')

export async function all(query: Parameters<ReturnType<typeof board>['tasks']['list']>[0]) {
  const team = personOwningEveryTaskTheirProfilesMade()
  const out: MessageView[] = []
  for (let after: string | undefined; ; ) {
    const page = await team.tasks.list({ ...query, after, limit: PAGE })
    out.push(...page.tasks.map((t) => t.message))
    if (page.tasks.length < PAGE) return out
    after = page.cursor
  }
}

export async function resolve(keyElseBoardId: string): Promise<MessageView> {
  const [found] = await all({ state: 'all', label: { key: keyElseBoardId } })
  if (found) return found
  const message = await personOwningEveryTaskTheirProfilesMade()
    .thread(keyElseBoardId, { limit: 1 })
    .then((t) => t.message)
    .catch(() => null)
  if (!message?.task) throw new Refused(`没有票 ${keyElseBoardId}`, 1, '票号照 nawaban list 里的写')
  return message
}

export async function bodyFrom(positional: string | undefined, flag: string | undefined, file: string | undefined): Promise<string | undefined> {
  const given = Object.entries({ 位置参数: positional, '--body': flag, '--body-file': file }).filter(([, v]) => v !== undefined)
  if (given.length > 1) throw new Refused(`正文给了 ${given.length} 处：${given.map(([where]) => where).join('、')}，只留一处`, 2)
  if (file !== undefined) return (await readFile(file, 'utf8')).replace(NEWLINE_A_FILE_ENDS_WITH_AS_BOARD_REPLY_DROPS_IT, '')
  if (positional === BODY_FROM_STDIN) return (await text(process.stdin)).replace(NEWLINE_A_FILE_ENDS_WITH_AS_BOARD_REPLY_DROPS_IT, '')
  return positional ?? flag
}

export const row = (m: MessageView) => `${key(m)}  ${state(m).padEnd(9)}  ${title(m)}`

type Verb = (argv: string[]) => Promise<Said>

const create: Verb = async (argv) => {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      title: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      parent: { type: 'string' },
      project: { type: 'string' },
      'blocked-by': { type: 'string', multiple: true },
      lane: { type: 'string' },
      inbox: { type: 'string' },
      json: { type: 'boolean' },
    },
  })
  const [keyAsPostIdSoCreatingAgainAnswersTheSameTask, bodyWord, ...extra] = positionals
  if (!keyAsPostIdSoCreatingAgainAnswersTheSameTask || extra.length || !values.title) {
    throw new Refused('用法：nawaban create <票> --title <标题> [正文] [--parent <票>] [--project <项目>] [--blocked-by <票>]… [--lane <泳道>] [--inbox <条目>]', 2)
  }
  const item = values.inbox === undefined ? null : await openInboxItem(personOwningEveryTaskTheirProfilesMade(), values.inbox)
  if (item && (await all({ state: 'all', label: { key: keyAsPostIdSoCreatingAgainAnswersTheSameTask } })).length) {
    throw new Refused(`已经有票 ${keyAsPostIdSoCreatingAgainAnswersTheSameTask}，收件箱条目不转进旧票`, 1, '换一个没用过的票号')
  }
  const body = (await bodyFrom(bodyWord, values.body, values['body-file'])) ?? item?.words
  if (values.body !== undefined) pointAt(withBody(['create', keyAsPostIdSoCreatingAgainAnswersTheSameTask], values.body, optionWordsBut(tokens, ['body'])))
  const parent = values.parent ? await resolve(values.parent) : null
  const project = values.project ?? parent?.channel ?? item?.project ?? (await projectOfThisRepository(boardDirAsConfiguredWhenAsked()))
  if (!project) throw new Refused(`不知道建在哪个项目：${process.cwd()} 不在 repos.json 的任何仓库里`, 2, '加 --project <项目>，或给一个有项目的 --parent')
  const needs = await Promise.all((values['blocked-by'] ?? []).map(async (b) => (await resolve(b)).id))
  const { task } = await personOwningEveryTaskTheirProfilesMade().tasks.create(project, {
    id: keyAsPostIdSoCreatingAgainAnswersTheSameTask,
    text: body ? `${values.title}\n\n${body}` : values.title,
    labels: { key: keyAsPostIdSoCreatingAgainAnswersTheSameTask, ...(parent ? { parent: key(parent) } : {}) },
    needs,
  })
  if (values.lane) await personOwningEveryTaskTheirProfilesMade().label(task.id, { set: { lane: values.lane } })
  if (item) await markInboxItemTurnedInto(personOwningEveryTaskTheirProfilesMade(), item.id, key(task))
  const notes = [values.lane && `泳道 ${values.lane}`, item && `收件箱 ${item.id} 已处理`].filter(Boolean)
  return { done: `建票 ${key(task)}：${title(task)}${notes.length ? `（${notes.join('，')}）` : ''}`, json: { task } }
}

const block: Verb = async (argv) => {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } })
  const [ref, by] = positionals
  if (!ref || !by || positionals.length !== 2) throw new Refused('用法：nawaban block <票> <挡它的票>', 2)
  const [task, blocker] = await Promise.all([resolve(ref), resolve(by)])
  const needs = [...new Set([...(task.task?.needs ?? []), blocker.id])]
  const updated = await personOwningEveryTaskTheirProfilesMade().tasks.needs(task.id, needs)
  return { done: `${key(task)} 被 ${key(blocker)} 挡住`, json: { task: updated } }
}

const list: Verb = async (argv) => {
  const { values } = parseArgs({
    args: argv,
    options: { project: { type: 'string' }, parent: { type: 'string' }, frontier: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const tasks = await all({
    channel: values.project,
    state: values.frontier ? 'ready' : 'open',
    label: values.parent ? { parent: values.parent } : undefined,
  })
  return { shown: tasks.map(row).join('\n') || '没有票', json: { tasks } }
}

const REPLIES_PAGE = 500

async function everyReplyOf(id: string): Promise<MessageView[]> {
  const team = personOwningEveryTaskTheirProfilesMade()
  const out: MessageView[] = []
  for (let afterTheRootTheBoardPagesFromTheOldest = id; ; ) {
    const { replies } = await team.thread(id, { after: afterTheRootTheBoardPagesFromTheOldest, limit: REPLIES_PAGE })
    out.push(...replies)
    if (replies.length < REPLIES_PAGE) return out
    afterTheRootTheBoardPagesFromTheOldest = replies.at(-1)!.id
  }
}

const indentedUnderItsHead = (text: string) => text.replace(/\n/g, '\n    ')
const eventLine = (m: MessageView) => `  ${m.createdAt}  ${m.author?.handle ?? '?'}  ${indentedUnderItsHead(m.text)}`

const show: Verb = async (argv) => {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { all: { type: 'boolean' }, json: { type: 'boolean' } } })
  const [ref] = positionals
  if (!ref || positionals.length !== 1) throw new Refused('用法：nawaban show <票> [--all]', 2)
  const task = await resolve(ref)
  const team = personOwningEveryTaskTheirProfilesMade()
  const [needs, downstream, summary] = await Promise.all([
    Promise.all((task.task?.needs ?? []).map((id) => team.thread(id, { limit: 1 }).then((t) => t.message))),
    all({ state: 'all', needs: task.id }),
    team.threads({ re: task.id, limit: 1 }),
  ])
  const events = values.all ? (await everyReplyOf(task.id)).filter((m) => !m.deleted) : null
  const latest = summary.threads[0]?.last ?? null
  const claim = live(task)
  const lines = [
    row(task),
    task.text.split('\n').slice(2).join('\n').trim() || undefined,
    '',
    `  project     ${task.channel}`,
    task.labels.parent && `  parent      ${task.labels.parent}`,
    `  holder      ${claim ? `${profileViaUser(claim.actor)} · until ${claim.until}` : 'none'}`,
    claim && task.labels.terminal && `  terminal    ${task.labels.terminal}`,
    task.task?.blocked && `  held        ${JSON.stringify(task.task.blocked)}`,
    `  blocked by  ${needs.map((m) => `${key(m)} ${state(m)}`).join(', ') || 'nothing'}`,
    `  downstream  ${downstream.map((m) => `${key(m)} ${state(m)}`).join(', ') || 'nothing'}`,
    `  latest      ${latest ? `${latest.author?.handle ?? '?'} · ${latest.createdAt}  ${latest.text.split('\n')[0]}` : 'nothing yet'}`,
  ]
  const everyEvent = events ? ['', `  events      ${events.length}`, ...events.map(eventLine)] : []
  return { shown: [...lines, ...everyEvent].filter((l) => typeof l === 'string').join('\n'), json: { task, needs, downstream, latest, ...(events ? { events } : {}) } }
}

const terminal = () => (process.env.CLAUDE_CODE_SESSION_ID ? process.env.HC_TERMINAL_ID : undefined)

export async function labelTerminalThePanelReadsWhileClaimed(taskId: string) {
  const t = terminal()
  await personOwningEveryTaskTheirProfilesMade().label(taskId, t ? { set: { terminal: t } } : { unset: ['terminal'] })
}

export const whyNotCloseable = (taskId: string) => undeclared(personOwningEveryTaskTheirProfilesMade(), taskId, boardDirAsConfiguredWhenAsked())

export async function forgetTheClaimOf(taskId: string) {
  await personOwningEveryTaskTheirProfilesMade().label(taskId, { unset: ['terminal', ...LIVE_LABELS] })
}

function refuseHeldByAnother(task: MessageView, as: string, next: string) {
  const held = live(task)
  if (held && !held.actor.endsWith(`+${as}`)) throw new Refused(`${key(task)} 在 ${profileViaUser(held.actor)} 手里，租约到 ${clock(held.until)}`, 1, next)
  return held
}

async function claimUpstream(task: MessageView, as: string): Promise<{ task: MessageView }> {
  const owner = task.task?.owner
  const keptForMe = task.task?.for === `${owner}+${as}`
  const keptUnderAnotherPrincipalsNameNoClaimOfMineMatches = keptForMe && owner !== ((await upstreamAnswer(['whoami'])) as { principal: string }).principal
  if (keptUnderAnotherPrincipalsNameNoClaimOfMineMatches) await upstreamAnswer(['tasks', 'assign', task.id, '--pool'])
  try {
    return (await upstreamAnswer(['tasks', 'claim', task.id, '--as', as, '--lease', LEASE])) as { task: MessageView }
  } catch (error) {
    if (keptUnderAnotherPrincipalsNameNoClaimOfMineMatches) await upstreamAnswer(['tasks', 'assign', task.id, as]).catch(() => undefined)
    throw error
  }
}

const claim: Verb = async (argv) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { release: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const [ref] = positionals
  if (!ref || positionals.length !== 1) throw new Refused('用法：nawaban claim <票> [--release]', 2)
  const task = await resolve(ref)
  const as = profile()
  if (values.release) {
    const { task: released } = (await upstreamAnswer(['tasks', 'release', task.id, '--as', as])) as { task: MessageView }
    await forgetTheClaimOf(task.id)
    await sayOnGithubToo(personOwningEveryTaskTheirProfilesMade(), boardDirAsConfiguredWhenAsked(), task, 'release', as)
    return { done: `交还 ${key(task)}`, json: { task: released } }
  }
  const held = refuseHeldByAnother(task, as, '等它交还，或让编排者改派')
  await refuseAClaimGithubAssignedToSomeoneElse(personOwningEveryTaskTheirProfilesMade(), boardDirAsConfiguredWhenAsked(), task)
  const { task: claimed } = await claimUpstream(task, as)
  await labelTerminalThePanelReadsWhileClaimed(task.id)
  if (!held) await sayOnGithubToo(personOwningEveryTaskTheirProfilesMade(), boardDirAsConfiguredWhenAsked(), task, 'claim', as + (terminal() ? `（hc ${terminal()}）` : ''))
  const until = claimed.task?.claim?.until
  return { done: `认领 ${key(task)}${until ? `，租约到 ${clock(until)}` : ''}`, json: { task: claimed } }
}

const KR_RESULT = new RegExp(`^(.+)=(?:(-?\\d+(?:\\.\\d+)?%?)\\s+(实测|预计)|(${UNMEASURED}))\\s*$`)

export function resultsOf(specs: string[]) {
  const krs = specs.map((spec) => {
    const [, name, after, basis, unmeasured] = KR_RESULT.exec(spec) ?? []
    if (!name) throw new Refused(`--kr 写成 ${RESULT_FORMAT}：${spec}`, 2)
    return unmeasured ? { name: name.trim(), basis: unmeasured } : { name: name.trim(), after: after!, basis: basis! }
  })
  return blockOf('nawaban-impact-result@2', { krs })
}

async function refuseUndeclaredBeforeClaimingSoNothingIsLeftBehind(team: ReturnType<typeof personOwningEveryTaskTheirProfilesMade>, task: MessageView, results: string | null): Promise<Said> {
  const as = profile()
  const held = refuseHeldByAnother(task, as, '等持票的 worker 自己关，或等它的租约过期')
  if (results) await team.reply(task.id, results)
  const why = await whyNotCloseable(task.id)
  if (why) {
    const [headline, ...next] = why.split('\n')
    throw new Refused(headline!, 1, next.join('\n').trim() || undefined)
  }
  if (!held) await claimUpstream(task, as)
  const { task: completed } = (await upstreamAnswer(['tasks', 'complete', task.id, '--as', as])) as { task: MessageView }
  await forgetTheClaimOf(task.id)
  await wantStateOnGithubToo(team, boardDirAsConfiguredWhenAsked(), task, 'completed')
  return { done: `关了 ${key(task)}（做完）`, json: { task: completed } }
}

async function needsWithoutAnyCanceledSinceBoardTakesNone(team: ReturnType<typeof personOwningEveryTaskTheirProfilesMade>, down: MessageView, canceled: MessageView) {
  const kept = await Promise.all(
    (down.task?.needs ?? []).map(async (id) =>
      id === canceled.id || (await team.thread(id, { limit: 1 })).message.task?.state === 'canceled' ? null : id,
    ),
  )
  return kept.filter((id) => id !== null)
}

async function cancelThenUnblockDownstreamSoACutRunNeverReadiesEarly(team: ReturnType<typeof personOwningEveryTaskTheirProfilesMade>, task: MessageView): Promise<Said> {
  if (task.task?.state !== 'canceled') await team.tasks.cancel(task.id, 'cancelled')
  await forgetTheClaimOf(task.id)
  await wantStateOnGithubToo(team, boardDirAsConfiguredWhenAsked(), task, 'not_planned')
  const stillWaitingRerunFinishesThem: string[] = []
  for (const down of await all({ state: 'open', needs: task.id })) {
    try {
      await team.tasks.needs(down.id, await needsWithoutAnyCanceledSinceBoardTakesNone(team, down, task))
    } catch (error) {
      stillWaitingRerunFinishesThem.push(`${key(down)}（${(error as Error).message}）`)
    }
  }
  if (stillWaitingRerunFinishesThem.length) {
    throw new Refused(`作废了 ${key(task)}，但这些还在等它：${stillWaitingRerunFinishesThem.join('、')}`, 1, '等没人拿着它们时再跑一次')
  }
  return { done: `作废 ${key(task)}，等它的票不再等`, json: { canceled: task.id } }
}

async function reopenOnGithub(team: ReturnType<typeof personOwningEveryTaskTheirProfilesMade>, task: MessageView): Promise<Said> {
  if (!(await wantStateOnGithubToo(team, boardDirAsConfiguredWhenAsked(), task, 'open'))) throw new Refused(`${key(task)} 不是推到 GitHub 的 issue 票：板上的票关了不重开，要接着做就新开一张`)
  return { done: `记下：联网时在 GitHub 上重开 ${key(task)}，轮询拉回来后开一张新票接过票号`, json: { reopen: task.id } }
}

const close: Verb = async (argv) => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { done: { type: 'boolean' }, cancelled: { type: 'boolean' }, reopen: { type: 'boolean' }, kr: { type: 'string', multiple: true }, json: { type: 'boolean' } },
  })
  const [ref] = positionals
  const ways = [values.done, values.cancelled, values.reopen].filter(Boolean).length
  if (!ref || positionals.length !== 1 || ways !== 1) throw new Refused('用法：nawaban close <票> (--done | --cancelled | --reopen)', 2)
  if (values.kr && !values.done) throw new Refused('--kr 报结果，只跟 --done 一起用', 2)
  const task = await resolve(ref)
  const team = personOwningEveryTaskTheirProfilesMade()
  if (values.reopen) return reopenOnGithub(team, task)
  if (values.done) return refuseUndeclaredBeforeClaimingSoNothingIsLeftBehind(team, task, values.kr ? resultsOf(values.kr) : null)
  return cancelThenUnblockDownstreamSoACutRunNeverReadiesEarly(team, task)
}

export const closeDone = (ref: string) => close([ref, '--done'])

export const profilesTheHookSessionMayHold = (session: string) => (['cx', 'agy', 'cc'] as const).map((agent) => sessionProfile(agent, session))

async function heldByAnyOf(profiles: string[]): Promise<{ id: string; channel: string; as: string; labels: Record<string, string> }[]> {
  return (await all({ state: 'claimed' })).flatMap((task) => {
    const claim = live(task)
    const as = profiles.find((p) => claim?.actor.endsWith(`+${p}`))
    return as ? [{ id: task.id, channel: task.channel, as, labels: task.labels }] : []
  })
}

type ClaimEvent = { type: string; actor: string | undefined; at: number }

async function claimEventsOf(task: { id: string; channel: string }): Promise<ClaimEvent[]> {
  const team = personOwningEveryTaskTheirProfilesMade()
  const found: ClaimEvent[] = []
  for (let after = task.id; ; ) {
    const { events, cursor } = await team.poll({ channel: task.channel, after })
    for (const e of events) {
      const p = e.payload as { id?: string; by?: { actor: string } }
      if (p.id === task.id && EVENTS_THAT_END_A_CLAIM.has(e.type)) found.push({ type: e.type, actor: p.by?.actor, at: Date.parse(e.createdAt) / 1000 })
    }
    const feedEndsWhereTheCursorStays = cursor === after
    if (feedEndsWhereTheCursorStays) return found
    after = cursor
  }
}

const claimedBy = (e: ClaimEvent | undefined, as: string) => e?.type === 'task.claimed' && !!e.actor?.endsWith(`+${as}`)

async function lastClaimedAt(task: { id: string; channel: string }, as: string): Promise<number> {
  return (await claimEventsOf(task)).findLast((e) => claimedBy(e, as))?.at ?? 0
}

const CLAIM_ENDED_BY_ITS_LEASE_OR_A_FAILED_CHECK_RUN = new Set(['task.claimed', 'task.expired', 'task.failed'])

export async function reclaimedIfItLapsedInMyHands(task: MessageView): Promise<MessageView> {
  if (live(task)) return task
  const as = profile()
  const events = await claimEventsOf(task)
  const ended = events.at(-1)?.type ?? ''
  const lapsedUntaken = CLAIM_ENDED_BY_ITS_LEASE_OR_A_FAILED_CHECK_RUN.has(ended) && claimedBy(events.findLast((e) => e.type === 'task.claimed'), as)
  if (!lapsedUntaken) return task
  if (ended === 'task.failed') await personOwningEveryTaskTheirProfilesMade().tasks.reopen(task.id)
  await claimUpstream(task, as)
  await labelTerminalThePanelReadsWhileClaimed(task.id)
  return resolve(key(task))
}

const STALE_HEARTBEAT = 'label_conflict'

async function keptOnlyWhileStillHeldAsRead(taskId: string, read: Record<string, string>, live: Live) {
  const stillAsRead = { 'board.task': 'claimed', terminal: read.terminal ?? null, 'progress.at': read['progress.at'] ?? null }
  await personOwningEveryTaskTheirProfilesMade()
    .label(taskId, { set: labelsOfLive(live), if: stillAsRead })
    .catch((error: { code?: string }) => {
      if (error.code !== STALE_HEARTBEAT) throw error
    })
}

export const heldBy = async (session: string): Promise<Held[]> =>
  Promise.all(
    (await heldByAnyOf(profilesTheHookSessionMayHold(session))).map(async (t) => ({
      id: t.id,
      claimedAt: await lastClaimedAt(t, t.as),
      live: liveOfLabels(t.labels),
      keep: (live: Live) => keptOnlyWhileStillHeldAsRead(t.id, t.labels, live),
    })),
  )

const renew = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({ args: argv, options: { session: { type: 'string' }, json: { type: 'boolean' } } })
  const held = await heldByAnyOf(values.session ? profilesTheHookSessionMayHold(values.session) : [profile()])
  let lastFailureWhileEveryClaimStillGetsItsRenewal = 0
  for (const { id, as } of held) {
    lastFailureWhileEveryClaimStillGetsItsRenewal =
      (await cliWhoseClaimsTheRenewHookFinds(['tasks', 'renew', id, '--as', as, '--lease', LEASE, ...(values.json ? ['--json'] : [])])) || lastFailureWhileEveryClaimStillGetsItsRenewal
  }
  return lastFailureWhileEveryClaimStillGetsItsRenewal
}

const SAYING: Record<string, Verb> = { create, block, list, show, claim, close }

const LEFT_TO_THE_BOARDS_CLI = undefined

export async function run(argv: string[]): Promise<number | undefined> {
  const [word, ...rest] = argv
  if (word === 'renew') return orRefusal(rest, () => renew(rest))
  if (word === undefined || !Object.hasOwn(SAYING, word)) return LEFT_TO_THE_BOARDS_CLI
  return answer(rest, () => SAYING[word]!(rest))
}
