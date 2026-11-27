import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { block, board, type MessageView } from '@vercel/board'
import { parse as parseYaml } from 'yaml'
import { checksOf, claimAssignedToMe, lastDispatchOf, mainCheckoutRealPathOf, NEXT_ACCEPT, orchestratorToReportTo, pickupBrief, stdoutOrNullOnFailure, terminalOf, workerProfileOf } from './dispatch.ts'
import { githubTokenOf } from './github-account.ts'
import { mergeGate, projectOf, tasksThePullRequestNames } from './impact.ts'
import { checkName, checkPassed, checkPending, checkSucceeded, type Check } from './pulls.ts'
import { DIR } from './server.ts'
import { all, closeDone, forgetTheClaimOf, live, profile, reclaimedIfItLapsedInMyHands, resolve, resultsOf, whyNotCloseable } from './tasks.ts'
import { answer, EXIT, Refused, upstreamAnswer, type Said } from './said.ts'

const exec = promisify(execFile)
const CLAIM_WAIT = '10m'
const USAGE = `用法：nawaban merge <PR 号> [--wait <时长>，领下一张最多等多久，默认 ${CLAIM_WAIT}] [--kr "<KR 名>=<后值> 实测|预计"]...`
const PR_FIELDS = 'number,state,url,title,body,headRefName,headRefOid,files,statusCheckRollup,comments,mergeCommit'
const NO_BLOCKER_REVIEW_LINE = /review[:：]\s*无挡/i
const SHA_PREFIX_A_REVIEW_NAMES = /\b[0-9a-f]{7,40}\b/gi
const WORKTREE_BRANCH = /^wt\/(.+)$/
const PULL_REQUEST_EVENTS = ['pull_request', 'pull_request_target']
const PULL_REQUEST_TYPES_A_PUSH_FIRES = ['opened', 'synchronize', 'reopened']
const SCHEMA_FILE = 'board/src/schemas.ts'
const LOCKFILE = 'pnpm-lock.yaml'
const PNPM_INSTALLED_LOCKFILE = 'node_modules/.pnpm/lock.yaml'
const EXIT_CODE = { waiting: EXIT.waiting, refused: EXIT.refused, mergedButUnfinished: EXIT.refused, done: EXIT.done } as const
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))
const CHECK_OUTPUT_TAIL_CHARS = 2000
const MERGE_RETRY_PAUSES_S = [2, 4, 8]
const GITHUB_HICCUP = 'GraphQL|HTTP 5[0-9][0-9]'
const mergeFailedMarkNoCheckCanForge = () => `nawaban: gh pr merge 没成 ${randomUUID()}`
const pluginDir = () => process.env.NAWABAN_PLUGIN_DIR ?? join(homedir(), '.nawaban', 'plugin')

type PullRequest = {
  number: number
  state: string
  url: string
  title: string
  body: string
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
  | { kind: 'done'; did: string[]; thenRetire: Retirable | null; pickedUp?: string }
type Run = { n: string; wait: string; kr: string[]; task: MessageView | null; root: string | null }
type Seen = { task: MessageView; terminal: string | null }

const failureOf = (error: unknown) => String((error as { stderr?: string }).stderr || (error as Error).message).trim()

async function viewOf(n: string): Promise<PullRequest> {
  return JSON.parse((await exec('gh', ['pr', 'view', n, '--json', PR_FIELDS])).stdout)
}

const lastDispatchedTerminal = (replies: MessageView[]) => lastDispatchOf(replies)?.terminal
const claimLive = (task: MessageView) => !!task.task?.claim && Date.parse(task.task.claim.until) > Date.now()
const terminalWhileClaimed = (task: MessageView) => (claimLive(task) ? task.labels.terminal : undefined)

export async function seenOf(task: MessageView): Promise<Seen> {
  const { replies } = await board().thread(task.id)
  return { task, terminal: terminalWhileClaimed(task) ?? lastDispatchedTerminal(replies) ?? null }
}

function ciVerdict(checks: Check[]): Outcome | null {
  if (!checks.length) return null
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

type TriggerFilter = { types?: string | string[]; branches?: string | string[]; 'branches-ignore'?: string | string[]; tags?: unknown; 'tags-ignore'?: unknown } | null
const listOf = (v: string | string[]) => (Array.isArray(v) ? v : [v]).map(String)

const regExpEscaped = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

function actionsFilterAsRegExp(glob: string) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    const classEnd = c === '[' ? glob.indexOf(']', i) : -1
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      out += '(?:.*/)?'
      i += 2
    } else if (c === '*' && glob[i + 1] === '*') {
      out += '.*'
      i++
    } else if (c === '*') out += '[^/]*'
    else if (c === '?' || c === '+') out += c
    else if (classEnd > i) {
      out += glob.slice(i, classEnd + 1)
      i = classEnd
    } else if (c === '\\' && i + 1 < glob.length) out += regExpEscaped(glob[++i]!)
    else out += regExpEscaped(c)
  }
  return new RegExp(`^${out}$`)
}

const globMatches = (glob: string, branch: string) => {
  try {
    return actionsFilterAsRegExp(glob).test(branch)
  } catch {
    return true
  }
}

const branchListMatches = (globs: string | string[], branch: string) =>
  listOf(globs).reduce((matched, glob) => (glob.startsWith('!') ? matched && !globMatches(glob.slice(1), branch) : matched || globMatches(glob, branch)), false)

function pushFiresOn(filter: TriggerFilter, branch: string) {
  if (!filter) return true
  if (filter.branches !== undefined) return branchListMatches(filter.branches, branch)
  if (filter['branches-ignore'] !== undefined) return !branchListMatches(filter['branches-ignore'], branch)
  return filter.tags === undefined && filter['tags-ignore'] === undefined
}

function runsOnThePullRequestHead(workflow: string, branch: string) {
  let on: unknown
  try {
    on = (parseYaml(workflow) as { on?: unknown } | null)?.on
  } catch {
    return true
  }
  if (!on) return true
  const triggers: Record<string, TriggerFilter> = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [String(e), null])) : (on as Record<string, TriggerFilter>)
  return Object.entries(triggers).some(([event, filter]) =>
    PULL_REQUEST_EVENTS.includes(event)
      ? !filter?.types || listOf(filter.types).some((t) => PULL_REQUEST_TYPES_A_PUSH_FIRES.includes(t))
      : event === 'push' && pushFiresOn(filter, branch),
  )
}

async function workflowsOfHeadElseNull(pr: PullRequest): Promise<Outcome | null> {
  await stdoutOrNullOnFailure('git', ['fetch', '-q', 'origin', `pull/${pr.number}/head`])
  const workflows = await stdoutOrNullOnFailure('git', ['ls-tree', '--name-only', pr.headRefOid, '.github/workflows/'])
  if (workflows === null) return { kind: 'refused', why: `本地读不到 head ${pr.headRefOid.slice(0, 7)}，核不了它带不带 workflow：先 git fetch 再跑` }
  if (!workflows.trim()) return null
  const listed = await stdoutOrNullOnFailure('gh', ['run', 'list', '--commit', pr.headRefOid, '--json', 'name,status,conclusion'])
  if (listed === null) return { kind: 'waiting', on: `查不到 head ${pr.headRefOid.slice(0, 7)} 的 workflow run（gh run list 失败）` }
  const runs: { name: string; status: string; conclusion: string }[] = JSON.parse(listed)
  const failed = runs.filter((r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'skipped')
  if (failed.length) return { kind: 'refused', why: `CI 没过：${failed.map((r) => r.name).join('、')}` }
  const running = runs.filter((r) => r.status !== 'completed')
  if (running.length) return { kind: 'waiting', on: `CI 还在跑：${running.map((r) => r.name).join('、')}` }
  if (runs.length) return null
  for (const path of workflows.split('\n').filter(Boolean)) {
    const text = await stdoutOrNullOnFailure('git', ['show', `${pr.headRefOid}:${path}`])
    if (text === null || runsOnThePullRequestHead(text, pr.headRefName)) return { kind: 'waiting', on: `${path} 会在 ${pr.headRefName} 上跑，head ${pr.headRefOid.slice(0, 7)} 还没有一次 run` }
  }
  return null
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

async function mergedAtHead(pr: PullRequest): Promise<boolean> {
  const again = await viewOf(String(pr.number)).catch(() => null)
  return again?.state === 'MERGED' && again.headRefOid === pr.headRefOid
}

async function mergeElseWhyNot(pr: PullRequest): Promise<string | null> {
  try {
    await exec('gh', ['pr', 'merge', String(pr.number), '--squash', '--match-head-commit', pr.headRefOid])
    return null
  } catch (error) {
    return (await mergedAtHead(pr)) ? null : `gh pr merge 失败：${failureOf(error)}`
  }
}

async function headCheckedOutCleanElseWhyNot(pr: PullRequest): Promise<string | null> {
  const head = (await stdoutOrNullOnFailure('git', ['rev-parse', 'HEAD']))?.trim()
  if (head !== pr.headRefOid) return `验收检查要在 PR head ${pr.headRefOid.slice(0, 7)} 上跑，这里是 ${head?.slice(0, 7) ?? '读不到的 HEAD'}：切到 PR 分支、pull 到 head 再跑`
  const status = await stdoutOrNullOnFailure('git', ['status', '--porcelain'])
  return status === null || status.trim() ? '工作区有没提交的改动，跑出来的不是 PR head：先提交或清掉' : null
}

const shQuoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

const mergeRetryingGithubHiccups = (pr: PullRequest, failedMark: string) => [
  `for pause in ${MERGE_RETRY_PAUSES_S.join(' ')} last; do`,
  `  out=$(gh pr merge ${pr.number} --squash --match-head-commit ${pr.headRefOid} 2>&1) && { printf '%s\\n' "$out"; exit 0; }`,
  `  printf '%s\\n' "$out" >&2`,
  `  [ "$pause" != last ] && printf '%s\\n' "$out" | grep -qE ${shQuoted(GITHUB_HICCUP)} || break`,
  `  sleep "$pause"`,
  'done',
  `printf '%s\\n' ${shQuoted(failedMark)} >&2`,
  'exit 1',
]

const eachCheckThenTheMerge = (checks: string[], pr: PullRequest, failedMark: string) =>
  [...checks.flatMap((c) => [`printf '%s\\n' ${shQuoted(`$ ${c}`)}`, `sh -c ${shQuoted(c)} || exit $?`]), ...mergeRetryingGithubHiccups(pr, failedMark)].join('\n')

function boardTasksRun(argv: string[], cwd: string): Promise<{ settled: { outcome?: string; task?: MessageView } | null; tail: string }> {
  return new Promise((done) => {
    const child = spawn('node', [CLI, 'board', 'tasks', 'run', ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let tail = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (tail = (tail + chunk).slice(-CHECK_OUTPUT_TAIL_CHARS)))
    const settle = () => {
      try {
        done({ settled: JSON.parse(out), tail })
      } catch {
        done({ settled: null, tail })
      }
    }
    child.on('close', settle)
    child.on('error', (error) => done({ settled: null, tail: error.message }))
  })
}

async function checksThenMergeAsOneTasksRunElseWhyNot(pr: PullRequest, task: MessageView, checks: string[], kr: string[]): Promise<string | null> {
  const off = await headCheckedOutCleanElseWhyNot(pr)
  if (off) return off
  if (kr.length) await board().as(profile()).reply(task.id, resultsOf(kr))
  const unreported = await whyNotCloseable(task.id)
  if (unreported) return `${unreported.split('\n')[0]}：验收检查通过就直接关票，KR 结果在 merge 时报：nawaban merge ${pr.number} --kr "<KR 名>=<后值> 实测|预计"`
  const top = (await stdoutOrNullOnFailure('git', ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) return '读不到仓库根目录，验收检查要在那里跑'
  const as = profile()
  const failedMark = mergeFailedMarkNoCheckCanForge()
  await upstreamAnswer(['tasks', 'release', task.id, '--as', as])
  const { settled, tail } = await boardTasksRun([task.id, '--as', as, '--result', `验收检查全过，已合 PR #${pr.number}`, '--json', '--', 'sh', '-c', eachCheckThenTheMerge(checks, pr, failedMark)], top)
  if (settled?.outcome === 'completed') return null
  const shown = tail.trim() || '（没有输出）'
  if (settled?.outcome === 'failed' && tail.includes(failedMark)) {
    await reclaimedIfItLapsedInMyHands(await resolve(task.labels.key ?? task.id))
    if (await mergedAtHead(pr)) return null
    return `合并失败（GitHub），验收检查全过，票没记 failed、仍由你认领：GitHub 恢复后直接重跑 nawaban merge ${pr.number}：\n${shown}`
  }
  if (settled?.outcome === 'failed') return `验收检查没过，票记 failed（${settled.task?.task?.reason ?? '?'}），修好后重跑 merge 会重开它：\n${shown}`
  return `tasks run 没跑成，票已交还：先 nawaban claim ${task.labels.key ?? task.id} 再重跑 merge：\n${shown}`
}

async function failureElseNull(cmd: string, args: string[]): Promise<string | null> {
  try {
    await exec(cmd, args)
    return null
  } catch (error) {
    return failureOf(error)
  }
}

const sameText = async (a: string, b: string) => (await readFile(a, 'utf8').catch(() => null)) === (await readFile(b, 'utf8').catch(() => undefined))

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
  const lockfiles = (await stdoutOrNullOnFailure('git', ['-C', plugin, 'ls-files', `*${LOCKFILE}`]))?.split('\n').filter(Boolean) ?? []
  for (const lockfile of lockfiles) {
    const dir = join(plugin, dirname(lockfile))
    if (await sameText(join(plugin, lockfile), join(dir, PNPM_INSTALLED_LOCKFILE))) continue
    const uninstalled = await failureElseNull('pnpm', ['--dir', dir, 'install', '--frozen-lockfile'])
    if (uninstalled) return { kind: 'mergedButUnfinished', left: `插件 ${lockfile} 和装好的依赖不一致，装依赖失败：${uninstalled}` }
    did.push(`插件 ${dirname(lockfile)} 依赖已装`)
  }
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
    await board().as(profile()).reply(task.id, block('nawaban-dispatch@2', { worker: (await terminalOf(holder))?.name ?? holder, terminal: holder, accept: NEXT_ACCEPT }))
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
  const unclosed = (await resolve(key)).task?.state === 'completed'
    ? await forgetTheClaimOf(task.id).then(() => null, (error: Error) => error.message)
    : await closeDone(key).then(() => null, (error: Error) => error.message)
  if (unclosed) return { kind: 'mergedButUnfinished', left: `close ${key} --done 失败：${unclosed}` }
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

async function claimNextElseRetire(closed: MessageView, root: string, did: string[], wait: string): Promise<Outcome> {
  const terminal = (await seenOf(closed)).terminal
  if (!terminal) return { kind: 'done', did, thenRetire: null }
  const worker = await terminalOf(terminal)
  const theWorkerItselfMerges = process.env.HC_TERMINAL_ID === terminal
  const as = theWorkerItselfMerges ? profile() : worker ? workerProfileOf(worker) : null
  const ofTheWorker = (actor: string | null | undefined) => !!as && !!actor?.endsWith(`+${as}`)
  const heldStill = async () =>
    (await all({ channel: closed.channel, state: 'open' })).find((t) => t.id !== closed.id && (terminalWhileClaimed(t) === terminal || ofTheWorker(live(t)?.actor)))
  const staysFor = (held: MessageView): Outcome => ({ kind: 'done', did: [...did, `${terminal} 还有 ${held.labels.key ?? held.id}，留着`], thenRetire: null })
  const held = await heldStill()
  if (held) return staysFor(held)
  if (worker?.state !== 'live') return { kind: 'done', did: [...did, `worker ${terminal} 已不在`], thenRetire: null }
  const worktree = worker.cwd && existsSync(worker.cwd) ? worker.cwd : null
  if (worktree && !theWorkerItselfMerges) return { kind: 'done', did: [...did, `worker ${terminal} 留着：merge 不在它的终端里跑，没替它领下一张，它自己 claim --ready 或由编排者收`], thenRetire: null }
  if (worktree) {
    let next: MessageView | null
    try {
      next = await claimAssignedToMe(closed.channel, wait)
    } catch (error) {
      return { kind: 'mergedButUnfinished', left: `领下一张出错，worker ${terminal} 留着：${failureOf(error)}` }
    }
    if (next) return { kind: 'done', did: [...did, `领到下一张 ${next.labels.key ?? next.id}`], thenRetire: null, pickedUp: await pickupBrief(next, worktree) }
    const claimedMeanwhile = await heldStill()
    if (claimedMeanwhile) return staysFor(claimedMeanwhile)
  }
  const retirable = await retirableElseWhyNot(terminal, root)
  if (typeof retirable === 'string') return { kind: 'mergedButUnfinished', left: retirable }
  return { kind: 'done', did: [...did, `收 worker ${terminal}`], thenRetire: retirable }
}

async function theOneTicketOfThisProjectThePullRequestNames(pr: PullRequest, root: string): Promise<MessageView | null> {
  const project = await projectOf(DIR, root)
  if (!project) return null
  const [only, ...more] = tasksThePullRequestNames(pr, (await all({ channel: project, state: 'all' })).filter((t) => t.task?.state !== 'canceled'))
  return more.length ? null : (only ?? null)
}

async function outcomeOf(r: Run): Promise<Outcome> {
  const pr = await viewOf(r.n)
  if (!r.root) return { kind: 'refused', why: '在本仓库的 worktree 里跑 merge' }
  const name = WORKTREE_BRANCH.exec(pr.headRefName)?.[1]
  r.task = (name ? await resolve(name.toUpperCase()).catch(() => null) : null) ?? (await theOneTicketOfThisProjectThePullRequestNames(pr, r.root))
  if (!r.task) return { kind: 'refused', why: `分支 ${pr.headRefName} 找不到票（要 wt/<票号小写>），PR 标题和正文的 Closes/Fixes/Refs 也没认出本项目唯一一张票` }
  const alreadyMerged = pr.state === 'MERGED' && !!pr.mergeCommit
  if (!alreadyMerged) {
    r.task = await reclaimedIfItLapsedInMyHands(r.task)
    const gate = await gateBeforeTheIrreversibleMerge(pr, r.task)
    if (gate) return gate
    const checks = checksOf((await board().thread(r.task.id)).replies)
    const failed = checks.length ? await checksThenMergeAsOneTasksRunElseWhyNot(pr, r.task, checks, r.kr) : await mergeElseWhyNot(pr)
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
  return pluginHold ?? unclosed ?? claimNextElseRetire(r.task, r.root, did, r.wait)
}

const noteOf = (o: Exclude<Outcome, { kind: 'waiting' }>, n: string) =>
  o.kind === 'done' ? `merge: 已合 PR #${n}，${o.did.slice(1).join('，')}` : o.kind === 'refused' ? `merge: 拒合 — ${o.why}` : `merge: 已合未收完 — ${o.left}`

const lineOf = (o: Exclude<Outcome, { kind: 'waiting' }>, n: string) =>
  o.kind === 'done' ? `已合 PR #${n}，${o.did.slice(1).join('，')}` : o.kind === 'refused' ? `拒合 PR #${n}：${o.why}` : `已合 PR #${n}，没收完：${o.left}`

async function tellOrchestrator(r: Run, line: string) {
  const orch = await orchestratorToReportTo(r.root, r.task)
  if (!orch) return process.stderr.write(`没有活着的编排者可告知：${line}\n`)
  const failed = await failureElseNull('hc', ['send', orch, line])
  if (failed) process.stderr.write(`hc send ${orch} 失败（${failed}）：${line}\n`)
}

async function noteElseWhyNot(r: Run, note: string): Promise<string | null> {
  try {
    if (r.task) await board().as(profile()).reply(r.task.id, note)
    return null
  } catch (error) {
    return `票上记不下：${failureOf(error)}`
  }
}

async function unfinished(r: Run, o: Exclude<Outcome, { kind: 'waiting' | 'done' }>): Promise<never> {
  const note = noteOf(o, r.n)
  const unrecorded = await noteElseWhyNot(r, note)
  await tellOrchestrator(r, `${r.task?.labels.key ?? ''} PR #${r.n} ${note}${unrecorded ? `（${unrecorded}）` : ''}`.replace(/\s*\n\s*/g, ' ').trim())
  throw new Refused(lineOf(o, r.n) + (unrecorded ? `（${unrecorded}）` : ''), EXIT_CODE[o.kind], `修好后重跑 nawaban merge ${r.n}`)
}

async function report(o: Outcome, r: Run): Promise<Said> {
  if (o.kind === 'waiting') throw new Refused(`PR #${r.n} 还在等：${o.on}`, EXIT_CODE.waiting, `过一会儿再跑 nawaban merge ${r.n}`)
  if (o.kind !== 'done') return unfinished(r, o)
  const unrecorded = await noteElseWhyNot(r, noteOf(o, r.n))
  if (unrecorded) return unfinished(r, { kind: 'mergedButUnfinished', left: `${unrecorded}，worker 没收` })
  const said = { done: lineOf(o, r.n), more: o.pickedUp, json: { pr: Number(r.n), ticket: r.task?.labels.key ?? null, did: o.did, retired: o.thenRetire?.terminal ?? null, ...(o.pickedUp ? { brief: o.pickedUp } : {}) } }
  if (!o.thenRetire) return said
  const { terminal, worktree } = o.thenRetire
  const notRemoved = worktree && (await failureElseNull('git', ['-C', r.root!, 'worktree', 'remove', worktree]))
  if (notRemoved) return unfinished(r, { kind: 'mergedButUnfinished', left: `worktree remove ${worktree} 失败：${notRemoved}` })
  const notKilled = await failureElseNull('hc', ['kill', terminal])
  return notKilled ? unfinished(r, { kind: 'mergedButUnfinished', left: `hc kill ${terminal} 失败：${notKilled}，重跑 merge 会再收` }) : said
}

export function merge(argv: string[]): Promise<number> {
  return answer(argv, async () => {
    let parsed
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, options: { wait: { type: 'string', default: CLAIM_WAIT }, kr: { type: 'string', multiple: true }, json: { type: 'boolean' } } })
    } catch {
      throw new Refused(USAGE, EXIT.misused)
    }
    const [n] = parsed.positionals
    if (parsed.positionals.length !== 1 || !/^\d+$/.test(n!)) throw new Refused(USAGE, EXIT.misused)
    process.env.GH_TOKEN = await githubTokenOf(process.cwd())
    const r: Run = { n: n!, wait: parsed.values.wait, kr: parsed.values.kr ?? [], task: null, root: await mainCheckoutRealPathOf(process.cwd()) }
    profile()
    return report(await outcomeOf(r), r)
  })
}
