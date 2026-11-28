import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve as absolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { block, board, type MessageView } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { accountElseNull } from './github-account.ts'
import { projectOfThisRepository, reposReadOnEveryUseSoEditsNeedNoRestart } from './impact.ts'
import { claudeTranscriptOf } from './narrate.ts'
import { SCHEMAS } from './schemas.ts'
import { boardDirAsConfiguredWhenAsked } from './server.ts'
import { all, key, labelTerminalThePanelReadsWhileClaimed, live, profile, resolve, row, sessionProfile, state } from './tasks.ts'
import { answer, EXIT, Refused, type Said } from './said.ts'

const exec = promisify(execFile)
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))
const PROBE_TIMEOUT_MS = 10_000
const WORKER_NAME = /^[a-z0-9_-]{1,32}$/
const PARSE_ARGS_MISTAKES = ['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE']
const CLOSED_STATES = ['completed', 'canceled', 'failed']
const ENV_NAMING_THIS_BOARD_AND_CODEX_CONFIG_NOT_THE_BOARD_TOKEN = ['NAWABAN_BOARD_DIR', 'NAWABAN_BOARD_PORT', 'BOARD_URL', 'CODEX_HOME']
const CLAUDE_MODEL_WHEN_NONE_IS_NAMED = 'opus'
const WORKER_TITLE_TASK_CHARS = 24
const CONVENTIONAL_PREFIX = /^\s*[a-z]+(?:\(([^)]*)\))?!?:\s*/i
const WORKER_ARGV = {
  claude: (model: string | undefined, brief: string, title?: string) => ['claude', ...(title ? ['-n', title] : []), '--model', model ?? CLAUDE_MODEL_WHEN_NONE_IS_NAMED, `/pstack:poteto-mode ${brief}`],
  codex: (model: string | undefined, brief: string) => ['codex', ...(model ? ['-m', model] : []), brief],
  agy: (model: string | undefined, brief: string) => ['agy', ...(model ? ['--model', model] : []), '-i', brief],
}

export function workerTitle(ticketTitle: string, tag: string): string {
  const prefix = ticketTitle.match(CONVENTIONAL_PREFIX)
  const scope = prefix?.[1]?.trim()
  const chars = Array.from(ticketTitle.slice(prefix?.[0].length ?? 0).trim())
  const task = chars.length > WORKER_TITLE_TASK_CHARS ? `${chars.slice(0, WORKER_TITLE_TASK_CHARS).join('')}…` : chars.join('')
  return `${scope ? `【${scope}】` : ''}${task} ${tag}`
}

const withoutSessionName = (argv: string[]) => {
  const at = argv.indexOf('-n')
  return at < 0 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)]
}
const PROFILE_PREFIX_OF_AGENT = { claude: 'cc', codex: 'cx', agy: 'agy' } as const
const CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000
const REUSE_WHILE_CONTEXT_SHARE_BELOW = 0.5
const CLAIM_LEASE = '1h'
const LANE_NOTE = /^\s*lane:\s*(\S.*?)\s*$/
const BRIEF_NOTE = '派发 brief：'
const NEXT_BRIEF = '照票正文和票上最新的决定'
export const NEXT_ACCEPT = '照票上 Acceptance criteria；开 PR 不合并'
const NOTHING_TO_CLAIM = ['nothing_ready', 'timeout']
const WAITING_FOR_INPUT = ['done', 'idle']
type Agent = keyof typeof WORKER_ARGV
const isAgent = (name: string): name is Agent => Object.hasOwn(WORKER_ARGV, name)
const USAGE = `用法：nawaban dispatch [<票>] --brief "<目标、范围>" --accept "<怎样算做完>" [--check '<验收命令>']... [--name <worker>] [--agent ${Object.keys(WORKER_ARGV).join('|')}] [--model <m>] [--to <终端> | --new]`
const USAGE_NEXT = 'nawaban dispatch --help 看每个参数'

type Args = { ref: string | undefined; name: string | undefined; brief: string; accept: string; checks: string[]; agent: Agent; model: string | undefined; to: string | undefined; fresh: boolean }
type Checked = { as: string; task: MessageView | null; root: string; orch: string; name: string; who: string; lane: string | null }
type Worktree = { path: string; branch: string }
type Terminal = { address: string; name?: string; state?: string; status?: { state?: string }; status_ms?: number; cwd?: string; foreground?: { cwd?: string }; argv?: string[]; labels?: Record<string, string> }
type Seat = { reuse: Terminal; task: MessageView; by: string | null; hint: string | null } | { reuse: null; passedOver: string[]; hint: string | null }

export async function stdoutOrNullOnFailure(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await exec(cmd, args, { timeout: PROBE_TIMEOUT_MS })).stdout
  } catch {
    return null
  }
}

export async function mainCheckoutRealPathOf(dir: string): Promise<string | null> {
  const common = await stdoutOrNullOnFailure('git', ['-C', dir, 'rev-parse', '--git-common-dir'])
  return common === null ? null : dirname(await realpath(absolute(dir, common.trim())))
}

export async function repositoryOfProject(project: string): Promise<string | null> {
  const path = (await reposReadOnEveryUseSoEditsNeedNoRestart(boardDirAsConfiguredWhenAsked()))[project]
  return path ? mainCheckoutRealPathOf(path) : null
}

export async function terminalOf(address: string): Promise<Terminal | null> {
  const got = await stdoutOrNullOnFailure('hc', ['get', address, '--json'])
  try {
    return got === null ? null : { address, ...JSON.parse(got) }
  } catch {
    return null
  }
}

const roleLabelOf = async (terminal: string) => (await terminalOf(terminal))?.labels?.role

async function thisTerminalIfOrchestrator(): Promise<string | null> {
  const me = process.env.HC_TERMINAL_ID
  return me && (await roleLabelOf(me)) === 'orchestrator' ? me : null
}

async function liveTerminals(): Promise<Terminal[]> {
  try {
    const listed: Terminal[] = JSON.parse((await stdoutOrNullOnFailure('hc', ['ls', '--json'])) ?? '').terminals ?? []
    return listed.filter((t) => t.state === 'live')
  } catch {
    return []
  }
}

export async function liveTerminalsInRepository(root: string): Promise<Terminal[]> {
  const inRepository: Terminal[] = []
  for (const t of await liveTerminals()) {
    if (t.cwd && (await mainCheckoutRealPathOf(t.cwd)) === root) inRepository.push(t)
  }
  return inRepository
}

export async function liveOrchestratorInRepository(root: string): Promise<string | null> {
  for (const t of await liveTerminals()) {
    const full = await terminalOf(t.address)
    const whereTheAgentRunsNotWhereTheShellStarted = full?.foreground?.cwd ?? t.cwd
    if (full?.labels?.role === 'orchestrator' && whereTheAgentRunsNotWhereTheShellStarted && (await mainCheckoutRealPathOf(whereTheAgentRunsNotWhereTheShellStarted)) === root) return t.address
  }
  return null
}

export async function orchestratorFor(root: string): Promise<string | null> {
  return (await thisTerminalIfOrchestrator()) ?? (await liveOrchestratorInRepository(root))
}

type Dispatched = { terminal: string; accept: string; orchestrator?: string }
const CHECKS_NOTE = '验收检查：'
export const checksOf = (replies: MessageView[]): string[] => {
  const latest = replies.map((r) => r.text).findLast((t) => t.startsWith(CHECKS_NOTE))
  return latest ? JSON.parse(latest.slice(CHECKS_NOTE.length)) : []
}

export const lastDispatchOf = (replies: MessageView[]) =>
  replies.flatMap((r) => r.blocks.filter((b) => b.schema === 'nawaban-dispatch').map((b) => b.data as Dispatched)).at(-1)

async function stillLiveOrchestrator(address: string): Promise<boolean> {
  const t = await terminalOf(address)
  return t?.state === 'live' && t.labels?.role === 'orchestrator'
}

async function dispatchedFromAnotherRepository(orchestrator: string, root: string | null): Promise<boolean> {
  const t = await terminalOf(orchestrator)
  const cwd = t?.foreground?.cwd ?? t?.cwd
  const its = cwd ? await mainCheckoutRealPathOf(cwd) : null
  return its !== null && its !== root
}

export async function orchestratorToReportTo(root: string | null, task: MessageView | null, threadOf = (id: string) => board().thread(id)): Promise<string | null> {
  const recorded = task ? lastDispatchOf((await threadOf(task.id)).replies)?.orchestrator : undefined
  const recordedLives = !!recorded && (await stillLiveOrchestrator(recorded))
  if (recordedLives && (await dispatchedFromAnotherRepository(recorded, root))) return recorded
  const inRepository = root ? await liveOrchestratorInRepository(root) : null
  return inRepository ?? (recordedLives ? recorded : null)
}

export type TerminalThatMayBeAWorker = Terminal & { inAWorktree: boolean }

export async function terminalsThatMayBeWorkers(root: string): Promise<TerminalThatMayBeAWorker[]> {
  const found: TerminalThatMayBeAWorker[] = []
  for (const t of await liveTerminalsInRepository(root)) {
    const full = await terminalOf(t.address)
    if (full?.labels?.role !== 'orchestrator') found.push({ ...t, ...full, inAWorktree: (await realpath(t.cwd!)) !== root })
  }
  return found
}

function parseDispatchArgs(argv: string[]): Args {
  const { values: a, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      brief: { type: 'string' },
      accept: { type: 'string' },
      check: { type: 'string', multiple: true },
      agent: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      to: { type: 'string' },
      new: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  })
  const [ref] = positionals
  if (positionals.length > 1 || !(ref || a.name) || !a.brief || !a.accept || !isAgent(a.agent!) || (a.to && a.new)) throw new Refused(USAGE, 2, USAGE_NEXT)
  if (a.check?.length && !ref) throw new Refused('--check 记在票上，merge 时跑：不带票的派发没有票可记', 2)
  return { ref, name: a.name, brief: a.brief, accept: a.accept, checks: a.check ?? [], agent: a.agent, model: a.model, to: a.to, fresh: !!a.new }
}

async function refuseBeforeAnythingStarts(a: Args): Promise<Checked> {
  const as = profile()
  const task = a.ref ? await resolve(a.ref) : null
  if (task && CLOSED_STATES.includes(task.task?.state ?? '')) throw new Refused(`${a.ref} 已经是 ${task.task?.state}，不开着`)
  const here = await mainCheckoutRealPathOf(process.cwd())
  const root = task ? await repositoryOfProject(task.channel) : here
  if (task && !root) throw new Refused(`${a.ref} 的项目 ${task.channel} 在 ${join(boardDirAsConfiguredWhenAsked(), 'repos.json')} 里没登记 git 仓库，不知道 worktree 建在哪`, 1, `在 repos.json 加 "${task.channel}": "<仓库路径>"`)
  if (!root) throw new Refused('dispatch 要在 worker 改的那个 git 仓库里跑')
  const orch = await orchestratorFor(here ?? root)
  if (!orch) throw new Refused('没有活着的编排者收回报', 1, '在本仓库的编排者终端里跑，或给它打上 role=orchestrator 标签')
  const name = a.name ?? a.ref!.toLowerCase()
  const who = a.ref ?? name
  if (!WORKER_NAME.test(name)) throw new Refused(`--name 只收 1 到 32 个 a-z 0-9 - _：${name}`, 2)
  return { as, task, root, orch, name, who, lane: task ? await laneOf(task) : null }
}

async function laneOf(task: MessageView): Promise<string | null> {
  if (task.labels.lane) return task.labels.lane
  const { replies } = await board().thread(task.id)
  return replies.map((r) => r.text.match(LANE_NOTE)?.[1]).findLast((lane) => lane !== undefined) ?? null
}

const startsTheWayThisDispatchWould = (t: Terminal, a: Pick<Args, 'agent' | 'model'>) => {
  const want = WORKER_ARGV[a.agent](a.model, '').slice(0, -1)
  const startedWith = withoutSessionName(t.argv ?? []).slice(-want.length - 1, -1)
  return startedWith.length === want.length && want.every((w, i) => startedWith[i] === w)
}

async function contextShareOf(t: Terminal): Promise<number | null> {
  const session = t.labels?.['revive.session']
  const transcript = t.labels?.['revive.agent'] === 'claude' && session ? await claudeTranscriptOf(session) : null
  if (!transcript) return null
  for (const line of (await readFile(transcript, 'utf8')).split('\n').reverse()) {
    let entry: { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, number> } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const u = entry.type === 'assistant' && !entry.isSidechain ? entry.message?.usage : undefined
    if (u) return ((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)) / CLAUDE_CONTEXT_WINDOW_TOKENS
  }
  return null
}

async function laneWorkersInRepository(root: string, lane: string): Promise<Terminal[]> {
  const workers: Terminal[] = []
  for (const t of await liveTerminalsInRepository(root)) {
    const full = await terminalOf(t.address)
    if (full?.labels?.lane === lane) workers.push(full)
  }
  return workers
}

const PATH_IN_BRIEF = /[\w.@-]+(?:\/[\w.@-]+)+\*?\/?|[\w.@-]+\/(?![\w.@-])|[\w-]+\.[A-Za-z][\w]{0,5}\b/g

const writtenPathsIn = (brief: string) => [...new Set(brief.match(PATH_IN_BRIEF) ?? [])]

const withoutTrailingSlash = (path: string) => path.replace(/\/$/, '')

export const pathsIn = (brief: string) => [...new Set(writtenPathsIn(brief).map(withoutTrailingSlash))]

const isDirectoryIn = (root: string, path: string) => {
  try {
    return statSync(join(root, path)).isDirectory()
  } catch {
    return false
  }
}

const writtenAsADirectory = (root: string, path: string) => path.endsWith('/') || path.endsWith('/*') || isDirectoryIn(root, path)

export const splitByFileOrDirectory = (root: string, brief: string) => {
  const written = writtenPathsIn(brief)
  const directories = new Set(written.filter((p) => writtenAsADirectory(root, p)).map(withoutTrailingSlash))
  return { files: pathsIn(brief).filter((p) => !directories.has(p)), directories: [...directories] }
}

const DIRECTORY_ONLY_HINT = '路径只写到目录，写到具体文件才能判重叠'

const touches = (changed: string, path: string) =>
  path.endsWith('*')
    ? changed.startsWith(path.slice(0, -1)) || changed.includes(`/${path.slice(0, -1)}`)
    : changed === path || changed.startsWith(`${path}/`) || changed.endsWith(`/${path}`)

async function filesChangedIn(worktree: string): Promise<string[]> {
  const committed = (await stdoutOrNullOnFailure('git', ['-C', worktree, 'diff', '--name-only', 'origin/main...HEAD'])) ?? ''
  const uncommitted = (await stdoutOrNullOnFailure('git', ['-C', worktree, 'status', '--porcelain', '-uall'])) ?? ''
  return [...new Set([...committed.split('\n'), ...uncommitted.split('\n').map((l) => l.slice(3).split(' -> ').at(-1)!)].filter(Boolean))]
}

const linesOf = (out: string | null | undefined) => (out ?? '').split('\n').map((l) => l.trim()).filter(Boolean)

async function filesOfTheMergedPullRequestFrom(root: string, branch: string): Promise<string[]> {
  const account = await accountElseNull(root)
  const token = account && (await stdoutOrNullOnFailure('gh', ['auth', 'token', '--user', account]))?.trim()
  if (account && !token) return []
  try {
    const { stdout } = await exec('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--limit', '1', '--json', 'files', '--jq', '.[0].files[]?.path'], {
      cwd: root,
      timeout: PROBE_TIMEOUT_MS,
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    })
    return linesOf(stdout)
  } catch {
    return []
  }
}

const worktreeNameOf = (root: string, cwd: string) => basename(cwd).slice(basename(root).length + 1)

const removedWorktreeOf = (root: string, cwd: string) => !existsSync(cwd) && dirname(cwd) === dirname(root) && basename(cwd).startsWith(`${basename(root)}-`)

async function filesOnTheWorkersMind(root: string, cwd: string): Promise<string[]> {
  if (!existsSync(cwd)) return filesOfTheMergedPullRequestFrom(root, `wt/${worktreeNameOf(root, cwd)}`)
  const changed = await filesChangedIn(cwd)
  if (changed.length) return changed
  for (const ref of ['HEAD', '@{-1}']) {
    const branch = (await stdoutOrNullOnFailure('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', ref]))?.trim()
    const merged = branch && branch !== 'HEAD' ? await filesOfTheMergedPullRequestFrom(root, branch) : []
    if (merged.length) return merged
  }
  return []
}

async function workersOfRepository(root: string): Promise<Terminal[]> {
  let terminals: Terminal[]
  try {
    terminals = JSON.parse((await stdoutOrNullOnFailure('hc', ['ls', '--json'])) ?? '').terminals ?? []
  } catch {
    return []
  }
  const found: Terminal[] = []
  for (const t of terminals) {
    if (t.state !== 'live' || !t.cwd) continue
    const inAWorktree = removedWorktreeOf(root, t.cwd) || (existsSync(t.cwd) && (await mainCheckoutRealPathOf(t.cwd)) === root && (await realpath(t.cwd)) !== root)
    const full = inAWorktree ? await terminalOf(t.address) : null
    if (full && full.labels?.role !== 'orchestrator') found.push({ ...t, ...full })
  }
  return found
}

type Overlap = { t: Terminal; files: string[] }

async function workersTouching(root: string, paths: string[]): Promise<Overlap[]> {
  if (!paths.length) return []
  const scored: Overlap[] = []
  for (const t of await workersOfRepository(root)) {
    const files = (await filesOnTheWorkersMind(root, t.cwd!)).filter((f) => paths.some((p) => touches(f, p)))
    if (files.length) scored.push({ t, files })
  }
  return scored.sort((a, b) => b.files.length - a.files.length || (b.t.status_ms ?? 0) - (a.t.status_ms ?? 0))
}

const overlapBy = (files: string[]) => `改动文件重叠：${files.join('、')}`

type Route = { reuse: Terminal | null; passedOver: string[]; by: string | null; hint: string | null }

async function routeByAffinity(root: string, lane: string | null, brief: string, a: Pick<Args, 'agent' | 'model'>): Promise<Route> {
  const { files, directories } = splitByFileOrDirectory(root, brief)
  const hint = !lane && directories.length && !files.length ? DIRECTORY_ONLY_HINT : null
  const candidates: Overlap[] = lane ? (await laneWorkersInRepository(root, lane)).map((t) => ({ t, files: [] })) : await workersTouching(root, files)
  const passedOver: string[] = []
  for (const { t, files: overlapping } of candidates) {
    const share = await contextShareOf(t)
    if (!startsTheWayThisDispatchWould(t, a)) passedOver.push(`${t.address} 跑的是别的 agent 或模型`)
    else if (share !== null && share >= REUSE_WHILE_CONTEXT_SHARE_BELOW) passedOver.push(`${t.address} 上下文已用 ${Math.round(share * 100)}%`)
    else return { reuse: t, passedOver, by: lane ? `泳道 ${lane}` : overlapBy(overlapping), hint }
  }
  return { reuse: null, passedOver, by: null, hint }
}

const WORKERS_PER_REPOSITORY_BEFORE_A_WARNING = 8

async function crowdedWarning(root: string): Promise<string | null> {
  const workers = (await terminalsThatMayBeWorkers(root)).filter((t) => t.inAWorktree).length
  return workers > WORKERS_PER_REPOSITORY_BEFORE_A_WARNING ? `本仓库已有 ${workers} 个活着的 worker，超过 ${WORKERS_PER_REPOSITORY_BEFORE_A_WARNING} 个：小票交给同线 worker，做完的收掉` : null
}

async function seatFor(c: Checked, a: Args): Promise<Seat> {
  if (a.to) {
    if (!c.task) throw new Refused('--to 把票指派给 worker 去领：不带票时去掉 --to，新开 worker', 2)
    const t = await terminalOf(a.to)
    if (t?.state !== 'live' || !t.cwd || (await mainCheckoutRealPathOf(t.cwd)) !== c.root) throw new Refused(`--to ${a.to} 不是本仓库里活着的终端`)
    return { reuse: t, task: c.task, by: null, hint: null }
  }
  if (a.fresh || !c.task) return { reuse: null, passedOver: [], hint: null }
  const route = await routeByAffinity(c.root, c.lane, a.brief, a)
  if (route.reuse && !existsSync(route.reuse.cwd!)) return { reuse: null, passedOver: [...route.passedOver, `${route.reuse.address} 的 worktree 已删`], hint: route.hint }
  return route.reuse ? { reuse: route.reuse, task: c.task, by: route.by, hint: route.hint } : { reuse: null, passedOver: route.passedOver, hint: route.hint }
}

const moreOf = (...lines: (string | null)[]) => (lines.some(Boolean) ? { more: lines.filter(Boolean).join('\n') } : {})

const ROUTE_USAGE = '用法：nawaban route --brief "<目标、范围>" [--agent claude|codex|agy] [--model <m>] [--json]'

export function route(argv: string[]): Promise<number> {
  return answer(argv, async () => {
    const { values: a } = parseArgs({ args: argv, options: { brief: { type: 'string' }, agent: { type: 'string', default: 'claude' }, model: { type: 'string' }, json: { type: 'boolean' } } })
    if (!a.brief || !isAgent(a.agent!)) throw new Refused(ROUTE_USAGE, 2)
    const root = await mainCheckoutRealPathOf(process.cwd())
    if (!root) throw new Refused('route 要在 worker 改的那个 git 仓库里跑')
    const r = await routeByAffinity(root, null, a.brief, { agent: a.agent, model: a.model })
    const warning = await crowdedWarning(root)
    return {
      done: r.reuse ? `交给 hc ${r.reuse.address}（${r.by}）` : '新开',
      ...moreOf(warning, r.hint),
      json: { terminal: r.reuse?.address ?? null, cwd: r.reuse?.cwd ?? null, by: r.by, passedOver: r.passedOver, warning, hint: r.hint },
    }
  })
}

async function worktreeOffOriginMain(root: string, name: string): Promise<Worktree> {
  const path = `${dirname(root)}/${basename(root)}-${name}`
  const branch = `wt/${name}`
  for (const args of [['fetch', '-q', 'origin', 'main'], ['worktree', 'add', '-q', '-b', branch, path, 'origin/main']]) {
    try {
      await exec('git', ['-C', root, ...args])
    } catch (error) {
      throw new Refused(`git ${args[0]} 失败：${String((error as { stderr?: string }).stderr ?? error).trim()}`)
    }
  }
  return { path, branch }
}

const MERGE_LINE = `收尾：验收没说不合并时，PR 的 CI 绿、评论里贴了带 head sha 的「Codex review：无挡…」之后，跑 nawaban merge <PR 号>：它合并、关票，再最多等 10 分钟领指派给你的下一张（Claude Code 里用 Bash 的 run_in_background 放后台跑，别干等）。领到就照它打印的 brief 在这个 worktree 切新分支接着做；没领到它收掉 worktree 和终端。票登记了 KR 时，merge 带上 --kr "<KR>=<后值> 实测|预计"`

const MERGE_LINE_WITH_NO_TICKET_FOR_NAWABAN_MERGE_TO_FIND = '收尾：验收没说不合并时，PR 的 CI 绿之后按仓库文档（如 docs/agents/review.md）的合并方式合；这次没有票，别用 nawaban merge'

const freshWorktreeLine = (wt: Worktree, merge: string) =>
  `worktree：${wt.path}（分支 ${wt.branch}，已从 origin/main 拉好；只在这里改，只在 ${wt.branch} 上提交和开 PR，不另开分支）。${merge}`

const reusedWorktreeLine = (wt: Worktree) =>
  `worktree：接着用 ${wt.path}，先 git fetch origin main && git switch -c ${wt.branch} origin/main，只在这个分支上改、提交和开 PR，不另开分支。${MERGE_LINE}`

type ReportsVia = { ref: string } | { name: string; orch: string }

const checksLines = (checks: string[]) =>
  checks.length ? ['验收检查（nawaban merge 合并前用看板的 tasks run 在 PR head 上逐条跑，全过才合并并关票；有一条非 0 就拒合，票记 failed 和输出尾巴。先在本地跑过）：', ...checks.map((c) => `  ${c}`)] : []

function briefReportingTo(via: ReportsVia, brief: string, accept: string, worktreeLine: string, firstSteps: string[] = [], checks: string[] = []): string {
  const [task, reportLines] =
    'ref' in via
      ? [`${via.ref}（nawaban show ${via.ref} 看全文；认领、进展、关闭用 nawaban claim|event|close 记）`, [`  nawaban tell ${via.ref} "完成 PR #<号>"`, `  nawaban tell ${via.ref} "受阻，详情在票上"`]]
      : [via.name, [`  hc send ${via.orch} "回报：${via.name} 完成 PR #<号>"`, `  hc send ${via.orch} "回报：${via.name} 受阻，详情在票上"`]]
  return [
    `任务：${task}`,
    worktreeLine,
    ...firstSteps,
    brief,
    `验收：${accept}`,
    ...checksLines(checks),
    '完成或受阻时只发下面一行，照抄其一，完成的填 PR 号。结论、实测输出、卡在哪、要谁做什么和中途进展都记在票上，不发给编排者（每条消息都会叫醒它）：',
    ...reportLines,
  ].join('\n')
}

const refusalOf = (stderr: string): { reason?: string; said: string } => {
  try {
    const { reason, message } = JSON.parse(stderr)
    return { reason, said: `${reason}: ${message}` }
  } catch {
    return { said: stderr.trim() }
  }
}

async function boardCliElseNothingToClaim(argv: string[], failing: string, nothingWhen: string[] = NOTHING_TO_CLAIM): Promise<string | null> {
  try {
    return (await exec('node', [CLI, 'board', ...argv])).stdout
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: string }
    const { reason, said } = refusalOf(stderr || (error as Error).message)
    if (code === 1 && reason && nothingWhen.includes(reason)) return null
    throw new Refused(`${failing}：${said}`)
  }
}

async function labelledForThePanel(claimed: string): Promise<MessageView> {
  const { task } = JSON.parse(claimed) as { task: MessageView }
  await labelTerminalThePanelReadsWhileClaimed(task.id).catch((error) =>
    process.stderr.write(`claimed ${task.labels.key ?? task.id}; its terminal label for the panel failed: ${(error as Error).message}\n`),
  )
  return task
}

export async function claimNextReady(project: string, wait?: string): Promise<MessageView | null> {
  const claimed = await boardCliElseNothingToClaim(['tasks', 'claim', project, '--ready', '--as', profile(), '--lease', CLAIM_LEASE, '--json', ...(wait ? ['--wait', wait] : [])], `在 ${project} 领下一张失败`)
  return claimed === null ? null : labelledForThePanel(claimed)
}

const DURATION = /^(\d+)(s|m|h)$/
const MS_PER = { s: 1_000, m: 60_000, h: 3_600_000 } as const
const LOOK_FOR_AN_ASSIGNED_TICKET_EVERY_MS = 15_000
const GONE_BETWEEN_LISTING_AND_CLAIMING = [...NOTHING_TO_CLAIM, 'task_assigned', 'task_claimed', 'task_blocked', 'task_waiting', 'task_finished']

function msOf(wait: string): number {
  const [, n, unit] = DURATION.exec(wait) ?? []
  if (!n) throw new Refused(`--wait 要写成 30s、10m、1h 这样的时长，不是 ${wait}`, EXIT.misused)
  return Number(n) * MS_PER[unit as keyof typeof MS_PER]
}

async function principalOfThisBoardToken(failing: string): Promise<string> {
  const said = await boardCliElseNothingToClaim(['whoami', '--json'], `${failing}，查不到看板令牌的身份`)
  return (JSON.parse(said!) as { principal: string }).principal
}

const readyAssignedTo = async (project: string, as: string) => (await all({ channel: project, state: 'ready' })).filter((t) => t.task?.for?.endsWith(`+${as}`))

export async function claimAssignedToMe(project: string, wait: string): Promise<MessageView | null> {
  const as = profile()
  const principal = await principalOfThisBoardToken(`在 ${project} 领下一张失败`)
  const until = Date.now() + msOf(wait)
  for (;;) {
    const [next] = await readyAssignedTo(project, as)
    const keptUnderItsOwnersName = !!next && next.task?.owner !== principal
    if (keptUnderItsOwnersName) await boardCliElseNothingToClaim(['tasks', 'assign', next.id, '--pool', '--json'], `${next.task?.owner} 替 ${as} 留的 #${next.id} 放回公共池失败`)
    const claimed = next ? await boardCliElseNothingToClaim(['tasks', 'claim', next.id, '--as', as, '--lease', CLAIM_LEASE, '--json'], `领指派给 ${as} 的 #${next.id} 失败`, GONE_BETWEEN_LISTING_AND_CLAIMING) : null
    if (claimed === null && keptUnderItsOwnersName) await boardCliElseNothingToClaim(['tasks', 'assign', next.id, as, '--json'], `#${next.id} 没领成，交还给 ${as} 失败`, GONE_BETWEEN_LISTING_AND_CLAIMING)
    const task = claimed === null ? null : (JSON.parse(claimed) as { task: MessageView }).task
    if (task && (keptUnderItsOwnersName || task.task?.for?.endsWith(`+${as}`))) return labelledForThePanel(claimed!)
    if (task) await boardCliElseNothingToClaim(['tasks', 'release', task.id, '--as', as, '--json'], `#${task.id} 认领时已回到公共池，交还失败`)
    const left = until - Date.now()
    if (left <= 0) return null
    await new Promise((r) => setTimeout(r, Math.min(LOOK_FOR_AN_ASSIGNED_TICKET_EVERY_MS, left)))
  }
}

export async function pickupBrief(task: MessageView, worktree: string): Promise<string> {
  const ref = task.labels.key ?? task.id
  const { replies } = await board().thread(task.id)
  const brief = replies.map((r) => r.text).findLast((t) => t.startsWith(BRIEF_NOTE))?.slice(BRIEF_NOTE.length) ?? NEXT_BRIEF
  const accept = lastDispatchOf(replies)?.accept ?? NEXT_ACCEPT
  const declareFirst = `这张已替你认领，但认领时没登记 KR 影响：先跑 nawaban event ${ref} impact --o "<O 名>" --kr "<KR>=toward|away|hold"（纯基础设施写 --o 无），不然 merge 会拦`
  return briefReportingTo({ ref }, brief, accept, reusedWorktreeLine({ path: worktree, branch: `wt/${ref.toLowerCase()}` }), [declareFirst], checksOf(replies))
}

export async function claimReady(wait: string | undefined, project: string | undefined): Promise<Said> {
  const worktree = (await stdoutOrNullOnFailure('git', ['rev-parse', '--show-toplevel']))?.trim()
  if (!worktree) throw new Refused('claim --ready 要在接票的 worktree 里跑')
  const channel = project ?? (await projectOfThisRepository(boardDirAsConfiguredWhenAsked(), worktree))
  if (!channel) throw new Refused(`${worktree} 不在 repos.json 的任何项目里`, 2, '加 --project <项目>')
  const task = (await claimAssignedToMe(channel, '0s')) ?? (await claimNextReady(channel, wait))
  if (!task) throw new Refused(`${channel} 里没有给 ${profile()} 的票${wait ? `，等了 ${wait}` : ''}`, 1, '等编排者派，或过会儿再跑 nawaban claim --ready')
  const brief = await pickupBrief(task, worktree)
  return { done: `领到 ${row(task)}`, more: brief, json: { task, brief } }
}

const envReachingThisBoardWithoutToken = () => ENV_NAMING_THIS_BOARD_AND_CODEX_CONFIG_NOT_THE_BOARD_TOKEN.flatMap((k) => (process.env[k] ? [`${k}=${process.env[k]}`] : []))

async function startWorkerElseRemoveWorktree(c: Checked, a: Args, wt: Worktree, brief: string): Promise<string> {
  const env = envReachingThisBoardWithoutToken()
  try {
    const run = await exec('hc', ['run', '--bg', '--outlive-parent', '--json', '--name', c.name, '--cwd', wt.path, ...(env.length ? ['env', ...env] : []), ...WORKER_ARGV[a.agent](a.model, brief, c.task ? workerTitle(c.task.text.split('\n')[0]!, a.ref!) : c.name)])
    const address = JSON.parse(run.stdout).address
    if (!address) throw new Error(run.stdout)
    return address
  } catch (error) {
    await stdoutOrNullOnFailure('git', ['-C', c.root, 'worktree', 'remove', '--force', wt.path])
    await stdoutOrNullOnFailure('git', ['-C', c.root, 'branch', '-D', wt.branch])
    throw new Refused(`hc run 失败，worktree 已删：${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`)
  }
}

export const workerProfileOf = (t: Terminal) => {
  const agent = t.labels?.['revive.agent']
  const session = t.labels?.['revive.session']
  return agent && session && isAgent(agent) ? sessionProfile(PROFILE_PREFIX_OF_AGENT[agent], session) : null
}

async function assignToRunningWorker(task: MessageView, worker: Terminal): Promise<string> {
  const as = workerProfileOf(worker)
  if (!as) throw new Refused(`hc ${worker.address} 没有 revive.agent 和 revive.session 标签，认不出它用哪个身份领票`, 1, '加 --new 新开 worker')
  try {
    await exec('node', [CLI, 'board', 'tasks', 'assign', task.id, as])
  } catch (error) {
    throw new Refused(`把 ${key(task)} 指派给 ${as} 失败，什么都没记：${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`)
  }
  return as
}

const claimableNowByAnIdleWorkerHoldingNothing = async (task: MessageView, worker: Terminal, as: string) =>
  state(task) === 'ready' &&
  WAITING_FOR_INPUT.includes(worker.status?.state ?? '') &&
  !(await all({ channel: task.channel, state: 'open' })).some((t) => live(t)?.actor?.endsWith(`+${as}`))

const wakeToClaim = async (worker: Terminal, who: string) =>
  (await stdoutOrNullOnFailure('hc', ['send', worker.address, `${who} 指派给你了：跑 nawaban claim --ready 领它，照打印的 brief 在这个 worktree 切新分支接着做`])) !== null

async function recordDispatchAsThisWindow(c: Checked, a: Args, address: string, worker = c.name) {
  const model = a.model ?? (a.agent === 'claude' ? CLAUDE_MODEL_WHEN_NONE_IS_NAMED : undefined)
  const value = { worker, terminal: address, accept: a.accept, orchestrator: c.orch, agent: a.agent, ...(model ? { model } : {}) }
  const why = checkValue(SCHEMAS['nawaban-dispatch@2'].schema, value)
  try {
    if (why) throw new Error(why)
    if (c.task) await board().as(c.as).reply(c.task.id, block('nawaban-dispatch@2', value))
  } catch (error) {
    throw new Refused(`已派给 hc ${address}，但记到 ${a.ref} 上失败：${(error as Error).message}`)
  }
}

async function recordChecksMergeRuns(c: Checked, a: Args, address: string) {
  if (!c.task || !a.checks.length) return
  try {
    await board().as(c.as).reply(c.task.id, `${CHECKS_NOTE}${JSON.stringify(a.checks)}`)
  } catch (error) {
    throw new Refused(`已派给 hc ${address}，但记验收检查到 ${a.ref} 上失败：${(error as Error).message}`)
  }
}

async function recordBriefThePickupReads(c: Checked, a: Args, task: MessageView, address: string) {
  try {
    await board().as(c.as).reply(task.id, `${BRIEF_NOTE}${a.brief}`)
  } catch (error) {
    throw new Refused(`已把 ${a.ref} 指派给 hc ${address}，但记 brief 失败：${(error as Error).message}`)
  }
}

const exitCodeOf = (error: unknown) =>
  error instanceof Refused ? error.code : PARSE_ARGS_MISTAKES.includes((error as { code?: string }).code ?? '') ? 2 : 1

export function dispatch(argv: string[]): Promise<number> {
  return answer(argv, async () => {
    const a = parseDispatchArgs(argv)
    const checked = await refuseBeforeAnythingStarts(a)
    const seat = await seatFor(checked, a)
    const lane = checked.lane ? `（泳道 ${checked.lane}）` : ''
    const warning = await crowdedWarning(checked.root)
    const warned = moreOf(warning, seat.hint)
    if (seat.reuse) {
      const worker = seat.reuse
      const as = await assignToRunningWorker(seat.task, worker)
      await recordDispatchAsThisWindow(checked, a, worker.address, worker.name ?? worker.address)
      await recordChecksMergeRuns(checked, a, worker.address)
      await recordBriefThePickupReads(checked, a, seat.task, worker.address)
      const woken = (await claimableNowByAnIdleWorkerHoldingNothing(seat.task, worker, as)) && (await wakeToClaim(worker, checked.who))
      const when = woken ? '它空着，已叫它现在领' : '它做完手上那张自己领'
      const why = seat.by && !checked.lane ? `（${seat.by}）` : lane
      return {
        ...warned,
        done: `${checked.who} 指派给在跑的 hc ${worker.address}${why}，${when} · 回报给 ${checked.orch}`,
        json: { ticket: checked.who, terminal: worker.address, profile: as, lane: checked.lane, orchestrator: checked.orch, assigned: true, woken },
      }
    }
    const wt = await worktreeOffOriginMain(checked.root, checked.name)
    const brief = briefReportingTo(a.ref ? { ref: a.ref } : { name: checked.name, orch: checked.orch }, a.brief, a.accept, freshWorktreeLine(wt, a.ref ? MERGE_LINE : MERGE_LINE_WITH_NO_TICKET_FOR_NAWABAN_MERGE_TO_FIND), [], a.checks)
    const address = await startWorkerElseRemoveWorktree(checked, a, wt, brief)
    if (checked.task?.task?.for) await boardCliElseNothingToClaim(['tasks', 'assign', checked.task.id, '--pool', '--json'], `已派给 hc ${address}，但 ${checked.who} 还排给 ${checked.task.task.for}，放回公共池失败，它领不了`)
    await recordDispatchAsThisWindow(checked, a, address)
    await recordChecksMergeRuns(checked, a, address)
    if (checked.lane) await stdoutOrNullOnFailure('hc', ['label', address, `lane=${checked.lane}`])
    const passedOver = seat.passedOver.length ? `，跳过了 ${seat.passedOver.join('；')}` : ''
    return {
      ...warned,
      done: `派出 ${checked.who} → hc ${address}${lane}${passedOver} · ${wt.path} · 回报给 ${checked.orch}`,
      json: { ticket: checked.who, terminal: address, worktree: wt.path, branch: wt.branch, lane: checked.lane, passedOver: seat.passedOver, orchestrator: checked.orch, assigned: false },
    }
  })
}

const TELL_USAGE = 'usage: nawaban tell <票> <一句>'

export async function tell(argv: string[]): Promise<number> {
  const [ref, ...words] = argv
  const line = words.join(' ').trim()
  if (!ref || !line) {
    process.stderr.write(`error: ${TELL_USAGE}\n`)
    return 2
  }
  try {
    const task = await resolve(ref)
    const key = task.labels.key ?? ref
    const orch = await orchestratorToReportTo(await mainCheckoutRealPathOf(process.cwd()), task)
    const sent = orch !== null && (await stdoutOrNullOnFailure('hc', ['send', orch, `回报：${key} ${line}`])) !== null
    if (sent) {
      process.stdout.write(`回报已发给 ${orch}\n`)
      return 0
    }
    await board().as(profile()).reply(task.id, `回报未送达：${line}`)
    process.stderr.write(`${orch ? `hc send ${orch} 失败` : '没找到活着的编排者'}，回报记在 ${key} 上\n`)
    return 0
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return exitCodeOf(error)
  }
}
