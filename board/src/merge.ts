import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { block, board, type MessageView } from '@vercel/board'
import { dispatch, LANE_NOTE, mainCheckoutRealPathOf, orchestratorFor, stdoutOrNullOnFailure, terminalOf } from './dispatch.ts'
import { mergeGate } from './impact.ts'
import { DIR } from './server.ts'
import { all, profile, Refused, resolve, run as taskVerb } from './tasks.ts'

const exec = promisify(execFile)
const USAGE = 'usage: nawaban merge <PR 号>'
const PR_FIELDS = 'number,state,url,title,headRefName,headRefOid,files,statusCheckRollup,comments,mergeCommit'
const PASSING_CHECK_RUN = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const PENDING_STATUS = ['PENDING', 'EXPECTED']
const NO_BLOCKER_REVIEW_LINE = /review[:：]\s*无挡/i
const SHA_PREFIX_A_REVIEW_NAMES = /\b[0-9a-f]{7,40}\b/gi
const WORKTREE_BRANCH = /^wt\/(.+)$/
const SCHEMA_FILE = 'board/src/schemas.ts'
const NEXT_BRIEF = '照票正文和票上最新的决定'
const NEXT_ACCEPT = '照票上 Acceptance criteria；开 PR 不合并'
const EXIT_CODE = { waiting: 3, refused: 1, mergedButUnfinished: 1, done: 0 } as const
const pluginDir = () => process.env.NAWABAN_PLUGIN_DIR ?? join(homedir(), '.nawaban', 'plugin')

type Check = { __typename: 'CheckRun'; name: string; status: string; conclusion: string } | { __typename: 'StatusContext'; context: string; state: string }
type PullRequest = {
  number: number
  state: string
  url: string
  title: string
  headRefName: string
  headRefOid: string
  files: { path: string }[]
  statusCheckRollup: Check[]
  comments: { body: string }[]
  mergeCommit: { oid: string } | null
}
type Outcome =
  | { kind: 'waiting'; on: string }
  | { kind: 'refused'; why: string }
  | { kind: 'mergedButUnfinished'; left: string }
  | { kind: 'done'; did: string[]; thenRetire: Retirable | null }
type Run = { n: string; task: MessageView | null; root: string | null }
type Seen = { task: MessageView; terminal: string | null; lane: string | null }

const failureOf = (error: unknown) => String((error as { stderr?: string }).stderr || (error as Error).message).trim()

async function viewOf(n: string): Promise<PullRequest> {
  return JSON.parse((await exec('gh', ['pr', 'view', n, '--json', PR_FIELDS])).stdout)
}

const lastDispatchedTerminal = (replies: MessageView[]) => replies.flatMap((r) => r.blocks.filter((b) => b.schema === 'nawaban-dispatch').map((b) => (b.data as { terminal: string }).terminal)).at(-1)
const claimLive = (task: MessageView) => !!task.task?.claim && Date.parse(task.task.claim.until) > Date.now()
const terminalWhileClaimed = (task: MessageView) => (claimLive(task) ? task.labels.terminal : undefined)

async function seenOf(task: MessageView): Promise<Seen> {
  const { replies } = await board().thread(task.id)
  const terminal = terminalWhileClaimed(task) ?? lastDispatchedTerminal(replies) ?? null
  const lane = replies.map((r) => r.text.match(LANE_NOTE)?.[1]).findLast((l) => l !== undefined) ?? null
  return { task, terminal, lane }
}

const checkName = (c: Check) => (c.__typename === 'StatusContext' ? c.context : c.name)
const checkPassed = (c: Check) => (c.__typename === 'StatusContext' ? c.state === 'SUCCESS' : c.status === 'COMPLETED' && PASSING_CHECK_RUN.includes(c.conclusion))
const checkSucceeded = (c: Check) => (c.__typename === 'StatusContext' ? c.state === 'SUCCESS' : c.conclusion === 'SUCCESS')
const checkPending = (c: Check) => (c.__typename === 'StatusContext' ? PENDING_STATUS.includes(c.state) : c.status !== 'COMPLETED')

function ciVerdict(checks: Check[]): Outcome | null {
  if (!checks.length) return { kind: 'waiting', on: 'CI 还没有任何 check' }
  const pending = checks.filter(checkPending)
  const failed = checks.filter((c) => !checkPending(c) && !checkPassed(c))
  if (failed.length) return { kind: 'refused', why: `CI 没过：${failed.map(checkName).join('、')}` }
  if (pending.length) return { kind: 'waiting', on: `CI 还在跑：${pending.map(checkName).join('、')}` }
  if (!checks.some(checkSucceeded)) return { kind: 'waiting', on: 'CI 只有跳过的 check，还没有跑过的' }
  return null
}

const onlyDocs = (pr: PullRequest) => pr.files.length > 0 && pr.files.every((f) => f.path.endsWith('.md'))
const reviewLineNamesHead = (line: string, head: string) =>
  NO_BLOCKER_REVIEW_LINE.test(line) && (line.match(SHA_PREFIX_A_REVIEW_NAMES) ?? []).some((sha) => head.startsWith(sha.toLowerCase()))
const reviewedAtHead = (pr: PullRequest) => pr.comments.some((c) => c.body.split('\n').some((line) => reviewLineNamesHead(line, pr.headRefOid)))

async function workflowsOfHeadElseNull(pr: PullRequest): Promise<Outcome | null> {
  await stdoutOrNullOnFailure('git', ['fetch', '-q', 'origin', `pull/${pr.number}/head`])
  const workflows = await stdoutOrNullOnFailure('git', ['ls-tree', '--name-only', pr.headRefOid, '.github/workflows/'])
  if (workflows === null) return { kind: 'refused', why: `本地读不到 head ${pr.headRefOid.slice(0, 7)}，核不了它带不带 workflow：先 git fetch 再跑` }
  if (!workflows.trim()) return null
  const listed = await stdoutOrNullOnFailure('gh', ['run', 'list', '--commit', pr.headRefOid, '--json', 'name,status,conclusion'])
  const runs: { name: string; status: string; conclusion: string }[] = listed ? JSON.parse(listed) : []
  if (!runs.length) return { kind: 'waiting', on: `仓库有 workflow，head ${pr.headRefOid.slice(0, 7)} 还没有一次 run` }
  const failed = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped')
  if (failed.length) return { kind: 'refused', why: `CI 没过：${failed.map((r) => r.name).join('、')}` }
  const running = runs.filter((r) => r.status !== 'completed')
  return running.length ? { kind: 'waiting', on: `CI 还在跑：${running.map((r) => r.name).join('、')}` } : null
}

function heldByThisSession(task: MessageView): string | null {
  const claim = task.task?.claim
  const me = profile()
  const live = claim && Date.parse(claim.until) > Date.now()
  return live && claim.actor.endsWith(`+${me}`) ? null : `${task.labels.key ?? task.id} 不在 ${me} 手里：持票的 worker 才能合并（先 claim）`
}

async function gateBeforeTheIrreversibleMerge(pr: PullRequest, task: MessageView): Promise<Outcome | null> {
  const notMine = heldByThisSession(task)
  if (notMine) return { kind: 'refused', why: notMine }
  if (pr.state !== 'OPEN') return { kind: 'refused', why: `PR #${pr.number} 是 ${pr.state}，不是 OPEN` }
  const ci = ciVerdict(pr.statusCheckRollup) ?? (await workflowsOfHeadElseNull(pr))
  if (ci) return ci
  if (!onlyDocs(pr) && !reviewedAtHead(pr)) {
    return { kind: 'refused', why: `没有对 head ${pr.headRefOid.slice(0, 7)} 的 review 无挡结论：PR 评论里贴一条顶格「Codex review：无挡合并」并写上这个 sha` }
  }
  const why = await mergeGate(`gh pr merge ${pr.number}`, process.cwd(), board(), DIR)
  return why ? { kind: 'refused', why } : null
}

async function mergeElseWhyNot(pr: PullRequest): Promise<string | null> {
  try {
    await exec('gh', ['pr', 'merge', String(pr.number), '--squash', '--match-head-commit', pr.headRefOid])
    return null
  } catch (error) {
    const again = await viewOf(String(pr.number)).catch(() => null)
    return again?.state === 'MERGED' && again.headRefOid === pr.headRefOid ? null : `gh pr merge 失败：${failureOf(error)}`
  }
}

async function failureElseNull(cmd: string, args: string[]): Promise<string | null> {
  try {
    await exec(cmd, args)
    return null
  } catch (error) {
    return failureOf(error)
  }
}

const originOf = async (dir: string) => (await stdoutOrNullOnFailure('git', ['-C', dir, 'remote', 'get-url', 'origin']))?.trim() || null

async function pluginHoldElsePull(did: string[]): Promise<Outcome | null> {
  const plugin = pluginDir()
  const ours = await originOf(process.cwd())
  if (!ours || ours !== (await originOf(plugin))) return null
  const unfetched = await failureElseNull('git', ['-C', plugin, 'fetch', '-q', 'origin', 'main'])
  if (unfetched) return { kind: 'mergedButUnfinished', left: `插件 fetch 失败：${unfetched}` }
  const incoming = await stdoutOrNullOnFailure('git', ['-C', plugin, 'diff', '--name-only', 'HEAD', 'origin/main'])
  if (incoming === null) return { kind: 'mergedButUnfinished', left: '读不到插件要拉进来的改动' }
  if (incoming.split('\n').some((path) => path === SCHEMA_FILE || path.includes('migrat'))) {
    return { kind: 'mergedButUnfinished', left: '插件要拉进来的改动里有 schema，要决策者点头再 pull；pull 之后重跑 merge 收尾' }
  }
  const failed = await failureElseNull('git', ['-C', plugin, 'merge', '-q', '--ff-only', 'origin/main'])
  if (failed) return { kind: 'mergedButUnfinished', left: `插件 pull 失败：${failed}` }
  did.push('插件已 pull')
  const modInstaller = join(plugin, 'herdr', 'install-mod.sh')
  const unsynced = existsSync(modInstaller) ? await failureElseNull('sh', [modInstaller]) : null
  if (unsynced) return { kind: 'mergedButUnfinished', left: `Herdr mod 同步失败：${unsynced}` }
  return null
}

async function recordTheWorkerBeforeCloseUnsetsItsLabel(task: MessageView): Promise<Outcome | null> {
  const holder = terminalWhileClaimed(task)
  if (!holder) return null
  if (lastDispatchedTerminal((await board().thread(task.id)).replies) === holder) return null
  try {
    await board().as(profile()).reply(task.id, block('nawaban-dispatch@1', { worker: (await terminalOf(holder))?.name ?? holder, terminal: holder, accept: NEXT_ACCEPT }))
    return null
  } catch (error) {
    return { kind: 'mergedButUnfinished', left: `记 worker ${holder} 失败：${failureOf(error)}` }
  }
}

async function linkThenClose(task: MessageView, pr: PullRequest, did: string[]): Promise<Outcome | null> {
  const unrecorded = await recordTheWorkerBeforeCloseUnsetsItsLabel(task)
  if (unrecorded) return unrecorded
  const { replies } = await board().thread(task.id)
  const linked = replies.some((r) => r.blocks.some((b) => b.schema === 'nawaban-link' && (b.data as { kind: string; ref: string }).kind === 'pr' && (b.data as { ref: string }).ref === pr.url))
  try {
    if (!linked) await board().as(profile()).reply(task.id, block('nawaban-link@1', { kind: 'pr', ref: pr.url }))
  } catch (error) {
    return { kind: 'mergedButUnfinished', left: `补 pr link 失败：${failureOf(error)}` }
  }
  const key = task.labels.key ?? task.id
  if ((await resolve(key)).task?.state !== 'completed' && (await taskVerb(['close', key, '--done'])) !== 0) return { kind: 'mergedButUnfinished', left: `close ${key} --done 失败` }
  did.push(`${key} 已关`)
  return null
}

type Retirable = { terminal: string; worktree: string | null }

async function retirableElseWhyNot(terminal: string, root: string): Promise<Retirable | string> {
  const t = await terminalOf(terminal)
  if (t?.state !== 'live' || !t.cwd) return `worker ${terminal} 不是在跑的终端`
  if (t.labels?.role === 'orchestrator') return `${terminal} 是编排者，不收`
  if (!existsSync(t.cwd)) return { terminal, worktree: null }
  if ((await mainCheckoutRealPathOf(t.cwd)) !== root) return `worker ${terminal} 不在本仓库`
  if ((await realpath(t.cwd)) === root) return `${terminal} 的 cwd 是主检出，不删`
  const status = await stdoutOrNullOnFailure('git', ['-C', t.cwd, 'status', '--porcelain'])
  if (status === null || status.trim()) return `${t.cwd} 有没提交的改动，worktree 留着`
  return { terminal, worktree: t.cwd }
}

async function handOnElseRetire(closed: MessageView, root: string, did: string[]): Promise<Outcome> {
  const mine = await seenOf(closed)
  const terminal = mine.terminal
  if (!terminal) return { kind: 'done', did, thenRetire: null }
  const others = await Promise.all((await all({ channel: closed.channel, state: 'open' })).filter((t) => t.id !== closed.id).map(seenOf))
  const stillHolding = others.find((o) => o.terminal === terminal)
  if (stillHolding) return { kind: 'done', did: [...did, `${terminal} 还有 ${stillHolding.task.labels.key ?? stillHolding.task.id}，留着`], thenRetire: null }
  const worker = await terminalOf(terminal)
  if (worker?.state !== 'live') return { kind: 'done', did: [...did, `worker ${terminal} 已不在`], thenRetire: null }
  const workerStillHasItsWorktree = !!worker.cwd && existsSync(worker.cwd)
  const next = mine.lane && workerStillHasItsWorktree ? others.find((o) => o.lane === mine.lane && o.task.task?.state === 'ready' && !o.terminal) : undefined
  if (next) {
    const key = next.task.labels.key ?? next.task.id
    if ((await dispatch([key, '--to', terminal, '--brief', NEXT_BRIEF, '--accept', NEXT_ACCEPT])) !== 0) return { kind: 'mergedButUnfinished', left: `把 ${key} 交给 ${terminal} 失败` }
    return { kind: 'done', did: [...did, `下一张 ${key} 交给 ${terminal}`], thenRetire: null }
  }
  const retirable = await retirableElseWhyNot(terminal, root)
  if (typeof retirable === 'string') return { kind: 'mergedButUnfinished', left: retirable }
  return { kind: 'done', did: [...did, `收 worker ${terminal}`], thenRetire: retirable }
}

async function outcomeOf(r: Run): Promise<Outcome> {
  const pr = await viewOf(r.n)
  const name = WORKTREE_BRANCH.exec(pr.headRefName)?.[1]
  r.task = name ? await resolve(name.toUpperCase()).catch(() => null) : null
  if (!r.task) return { kind: 'refused', why: `分支 ${pr.headRefName} 找不到票（要 wt/<票号小写>）` }
  if (!r.root) return { kind: 'refused', why: '在本仓库的 worktree 里跑 merge' }
  const alreadyMerged = pr.state === 'MERGED' && !!pr.mergeCommit
  if (!alreadyMerged) {
    const gate = await gateBeforeTheIrreversibleMerge(pr, r.task)
    if (gate) return gate
    const failed = await mergeElseWhyNot(pr)
    if (failed) return { kind: 'refused', why: failed }
  }
  const did = [`PR #${pr.number} 已合`]
  const pluginHold = await pluginHoldElsePull(did)
  const mainCheckoutIsThePlugin = (await realpath(pluginDir()).catch(() => null)) === r.root
  if (!mainCheckoutIsThePlugin) {
    const pulled = await failureElseNull('git', ['-C', r.root, 'pull', '--ff-only'])
    if (pulled) return { kind: 'mergedButUnfinished', left: `主检出 pull 失败：${pulled}` }
    did.push('主检出已 pull')
  }
  const unclosed = await linkThenClose(r.task, pr, did)
  return pluginHold ?? unclosed ?? handOnElseRetire(r.task, r.root, did)
}

const noteOf = (o: Exclude<Outcome, { kind: 'waiting' }>, n: string) =>
  o.kind === 'done' ? `merge: 已合 PR #${n}，${o.did.slice(1).join('，')}` : o.kind === 'refused' ? `merge: 拒合 — ${o.why}` : `merge: 已合未收完 — ${o.left}`

async function tellOrchestrator(root: string | null, line: string) {
  const orch = root ? await orchestratorFor(root) : null
  if (!orch) return process.stderr.write(`no live orchestrator to tell: ${line}\n`)
  const failed = await failureElseNull('hc', ['send', orch, line])
  if (failed) process.stderr.write(`hc send ${orch} failed (${failed}): ${line}\n`)
}

async function noteElseWhyNot(r: Run, note: string): Promise<string | null> {
  process.stdout.write(note + '\n')
  try {
    if (r.task) await board().as(profile()).reply(r.task.id, note)
    return null
  } catch (error) {
    return `票上记不下：${failureOf(error)}`
  }
}

async function unfinished(r: Run, o: Exclude<Outcome, { kind: 'waiting' | 'done' }>): Promise<number> {
  const note = noteOf(o, r.n)
  const unrecorded = await noteElseWhyNot(r, note)
  await tellOrchestrator(r.root, `${r.task?.labels.key ?? ''} PR #${r.n} ${note}${unrecorded ? `（${unrecorded}）` : ''}`.replace(/\s*\n\s*/g, ' ').trim())
  return EXIT_CODE[o.kind]
}

async function report(o: Outcome, r: Run): Promise<number> {
  if (o.kind === 'waiting') {
    process.stdout.write(`PR #${r.n} 等着：${o.on}\n`)
    return EXIT_CODE.waiting
  }
  if (o.kind !== 'done') return unfinished(r, o)
  const unrecorded = await noteElseWhyNot(r, noteOf(o, r.n))
  if (unrecorded) return unfinished(r, { kind: 'mergedButUnfinished', left: `${unrecorded}，worker 没收` })
  if (!o.thenRetire) return EXIT_CODE.done
  const { terminal, worktree } = o.thenRetire
  const notRemoved = worktree && (await failureElseNull('git', ['-C', r.root!, 'worktree', 'remove', worktree]))
  if (notRemoved) return unfinished(r, { kind: 'mergedButUnfinished', left: `worktree remove ${worktree} 失败：${notRemoved}` })
  const notKilled = await failureElseNull('hc', ['kill', terminal])
  return notKilled ? unfinished(r, { kind: 'mergedButUnfinished', left: `hc kill ${terminal} 失败：${notKilled}，重跑 merge 会再收` }) : EXIT_CODE.done
}

export async function merge(argv: string[]): Promise<number> {
  const [n] = argv
  if (argv.length !== 1 || !/^\d+$/.test(n!)) {
    process.stderr.write(`error: ${USAGE}\n`)
    return 2
  }
  const r: Run = { n: n!, task: null, root: await mainCheckoutRealPathOf(process.cwd()) }
  try {
    profile()
    return await report(await outcomeOf(r), r)
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return error instanceof Refused ? error.code : 1
  }
}
