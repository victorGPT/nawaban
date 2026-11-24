import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve as absolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { block, board, type MessageView } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { projectOf } from './impact.ts'
import { claudeTranscriptOf } from './narrate.ts'
import { SCHEMAS } from './schemas.ts'
import { boardDirAsConfiguredWhenAsked } from './server.ts'
import { labelTerminalThePanelReadsWhileClaimed, profile, Refused, resolve, row, sessionProfile } from './tasks.ts'

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
type Agent = keyof typeof WORKER_ARGV
const isAgent = (name: string): name is Agent => Object.hasOwn(WORKER_ARGV, name)
const USAGE =
  `usage: nawaban dispatch [<key>] --brief "<goal, scope>" --accept "<what counts as done>" [--name <worker>] [--agent ${Object.keys(WORKER_ARGV).join('|')}] [--model <m>, opus for claude] [--to <terminal> | --new]; --to, or a task with a lane: note while that lane has a live worker, assigns the task to that worker, which claims it once its ticket is done; --new starts a worker; no key (a nightly retro, say) takes --name and records nothing`

type Args = { ref: string | undefined; name: string | undefined; brief: string; accept: string; agent: Agent; model: string | undefined; to: string | undefined; fresh: boolean }
type Checked = { as: string; task: MessageView | null; root: string; orch: string; name: string; who: string; lane: string | null }
type Worktree = { path: string; branch: string }
type Terminal = { address: string; name?: string; state?: string; cwd?: string; argv?: string[]; labels?: Record<string, string> }
type Seat = { reuse: Terminal; task: MessageView } | { reuse: null; passedOver: string[] }

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

export async function liveTerminalsInRepository(root: string): Promise<Terminal[]> {
  let terminals: Terminal[]
  try {
    terminals = JSON.parse((await stdoutOrNullOnFailure('hc', ['ls', '--json'])) ?? '').terminals ?? []
  } catch {
    return []
  }
  const inRepository: Terminal[] = []
  for (const t of terminals) {
    if (t.state === 'live' && t.cwd && (await mainCheckoutRealPathOf(t.cwd)) === root) inRepository.push(t)
  }
  return inRepository
}

async function liveOrchestratorInRepository(root: string): Promise<string | null> {
  for (const t of await liveTerminalsInRepository(root)) {
    if ((await roleLabelOf(t.address)) === 'orchestrator') return t.address
  }
  return null
}

export async function orchestratorFor(root: string): Promise<string | null> {
  return (await thisTerminalIfOrchestrator()) ?? (await liveOrchestratorInRepository(root))
}

type Dispatched = { terminal: string; accept: string; orchestrator?: string }
export const lastDispatchOf = (replies: MessageView[]) =>
  replies.flatMap((r) => r.blocks.filter((b) => b.schema === 'nawaban-dispatch').map((b) => b.data as Dispatched)).at(-1)

async function stillLiveOrchestrator(address: string): Promise<boolean> {
  const t = await terminalOf(address)
  return t?.state === 'live' && t.labels?.role === 'orchestrator'
}

export async function orchestratorToReportTo(root: string | null, task: MessageView | null): Promise<string | null> {
  const inRepository = root ? await liveOrchestratorInRepository(root) : null
  if (inRepository || !task) return inRepository
  const recorded = lastDispatchOf((await board().thread(task.id)).replies)?.orchestrator
  return recorded && (await stillLiveOrchestrator(recorded)) ? recorded : null
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
      agent: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      to: { type: 'string' },
      new: { type: 'boolean' },
    },
  })
  const [ref] = positionals
  if (positionals.length > 1 || !(ref || a.name) || !a.brief || !a.accept || !isAgent(a.agent!) || (a.to && a.new)) throw new Refused(USAGE, 2)
  return { ref, name: a.name, brief: a.brief, accept: a.accept, agent: a.agent, model: a.model, to: a.to, fresh: !!a.new }
}

async function refuseBeforeAnythingStarts(a: Args): Promise<Checked> {
  const as = profile()
  const task = a.ref ? await resolve(a.ref) : null
  if (task && CLOSED_STATES.includes(task.task?.state ?? '')) throw new Refused(`${a.ref} is ${task.task?.state}, not open`)
  const root = await mainCheckoutRealPathOf(process.cwd())
  if (!root) throw new Refused('run dispatch inside the git repository the worker changes')
  const orch = await orchestratorFor(root)
  if (!orch) throw new Refused('no live orchestrator (a terminal labelled role=orchestrator in this repository) to take the report')
  const name = a.name ?? a.ref!.toLowerCase()
  const who = a.ref ?? name
  if (!WORKER_NAME.test(name)) throw new Refused(`--name takes 1-32 of a-z 0-9 - _: ${name}`, 2)
  return { as, task, root, orch, name, who, lane: task ? await laneOf(task) : null }
}

async function laneOf(task: MessageView): Promise<string | null> {
  const { replies } = await board().thread(task.id)
  return replies.map((r) => r.text.match(LANE_NOTE)?.[1]).findLast((lane) => lane !== undefined) ?? null
}

const startsTheWayThisDispatchWould = (t: Terminal, a: Args) => {
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

async function seatFor(c: Checked, a: Args): Promise<Seat> {
  if (a.to) {
    if (!c.task) throw new Refused('--to assigns a ticket for the worker to claim: with no ticket, start a worker without --to', 2)
    const t = await terminalOf(a.to)
    if (t?.state !== 'live' || !t.cwd || (await mainCheckoutRealPathOf(t.cwd)) !== c.root) throw new Refused(`--to ${a.to} is no live terminal in this repository`)
    return { reuse: t, task: c.task }
  }
  if (a.fresh || !c.lane || !c.task) return { reuse: null, passedOver: [] }
  const passedOver: string[] = []
  for (const t of await laneWorkersInRepository(c.root, c.lane)) {
    const share = await contextShareOf(t)
    if (!startsTheWayThisDispatchWould(t, a)) passedOver.push(`${t.address} runs another agent or model`)
    else if (share !== null && share >= REUSE_WHILE_CONTEXT_SHARE_BELOW) passedOver.push(`${t.address} has used ${Math.round(share * 100)}% of its context`)
    else return { reuse: t, task: c.task }
  }
  return { reuse: null, passedOver }
}

async function worktreeOffOriginMain(root: string, name: string): Promise<Worktree> {
  const path = `${dirname(root)}/${basename(root)}-${name}`
  const branch = `wt/${name}`
  for (const args of [['fetch', '-q', 'origin', 'main'], ['worktree', 'add', '-q', '-b', branch, path, 'origin/main']]) {
    try {
      await exec('git', ['-C', root, ...args])
    } catch (error) {
      throw new Refused(`git ${args[0]} failed: ${String((error as { stderr?: string }).stderr ?? error).trim()}`)
    }
  }
  return { path, branch }
}

const MERGE_LINE = `收尾：验收没说不合并时，PR 的 CI 绿、评论里贴了带 head sha 的「Codex review：无挡…」之后，跑 node ${CLI} merge <PR 号>：它合并、关票，再最多等 10 分钟领指派给你的下一张（Claude Code 里用 Bash 的 run_in_background 放后台跑，别干等）。领到就照它打印的 brief 在这个 worktree 切新分支接着做；没领到它收掉 worktree 和终端`

const freshWorktreeLine = (wt: Worktree) =>
  `worktree：${wt.path}（分支 ${wt.branch}，已从 origin/main 拉好；只在这里改）。${MERGE_LINE}`

const reusedWorktreeLine = (wt: Worktree) =>
  `worktree：接着用 ${wt.path}，先 git fetch origin main && git switch -c ${wt.branch} origin/main，只在这个分支上改。${MERGE_LINE}`

type ReportsVia = { ref: string } | { name: string; orch: string }

function briefReportingTo(via: ReportsVia, brief: string, accept: string, worktreeLine: string, firstSteps: string[] = []): string {
  const nawaban = `node ${CLI}`
  const [task, reportLines] =
    'ref' in via
      ? [`${via.ref}（${nawaban} show ${via.ref} 看全文；认领、进展、关闭用 ${nawaban} claim|event|close 记）`, [`  ${nawaban} tell ${via.ref} "完成 PR #<号>"`, `  ${nawaban} tell ${via.ref} "受阻，详情在票上"`]]
      : [via.name, [`  hc send ${via.orch} "回报：${via.name} 完成 PR #<号>"`, `  hc send ${via.orch} "回报：${via.name} 受阻，详情在票上"`]]
  return [
    `任务：${task}`,
    worktreeLine,
    ...firstSteps,
    brief,
    `验收：${accept}`,
    '完成或受阻：只发一行，照抄其一，PR 号填上；结论、实测输出、卡在哪、要谁做什么都写在票上：',
    ...reportLines,
    '只发这一行：中途进展、阶段结果记在票上的「进展」里，不发给编排者（每条消息都会叫醒它，留在它的上下文里）。',
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

export async function claimNextReady(project: string, wait?: string): Promise<MessageView | null> {
  const argv = [CLI, 'board', 'tasks', 'claim', project, '--ready', '--as', profile(), '--lease', CLAIM_LEASE, '--json', ...(wait ? ['--wait', wait] : [])]
  let claimed: string
  try {
    claimed = (await exec('node', argv)).stdout
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: string }
    const { reason, said } = refusalOf(stderr || (error as Error).message)
    if (code === 1 && reason && NOTHING_TO_CLAIM.includes(reason)) return null
    throw new Refused(`claim --ready in ${project} failed: ${said}`)
  }
  const { task } = JSON.parse(claimed) as { task: MessageView }
  try {
    await labelTerminalThePanelReadsWhileClaimed(task.id)
  } catch (error) {
    throw new Refused(`claimed ${task.labels.key ?? task.id}, but labelling its terminal failed: ${(error as Error).message}`)
  }
  return task
}

export async function pickupBrief(task: MessageView, worktree: string): Promise<string> {
  const ref = task.labels.key ?? task.id
  const { replies } = await board().thread(task.id)
  const brief = replies.map((r) => r.text).findLast((t) => t.startsWith(BRIEF_NOTE))?.slice(BRIEF_NOTE.length) ?? NEXT_BRIEF
  const accept = lastDispatchOf(replies)?.accept ?? NEXT_ACCEPT
  const declareFirst = `这张已替你认领，但认领时没登记 KR 影响：先跑 node ${CLI} event ${ref} impact --o "<O 名>" --kr "<KR>=toward|away|hold"（纯基础设施写 --o 无），不然 merge 会拦`
  return briefReportingTo({ ref }, brief, accept, reusedWorktreeLine({ path: worktree, branch: `wt/${ref.toLowerCase()}` }), [declareFirst])
}

export async function claimReady(wait: string | undefined, project: string | undefined, json: boolean): Promise<number> {
  const worktree = (await stdoutOrNullOnFailure('git', ['rev-parse', '--show-toplevel']))?.trim()
  if (!worktree) throw new Refused('claim --ready runs in the worktree that takes the ticket')
  const root = (await mainCheckoutRealPathOf(worktree)) ?? worktree
  const channel = project ?? (await projectOf(boardDirAsConfiguredWhenAsked(), root))
  if (!channel) throw new Refused(`${root} is no project in repos.json: pass --project`, 2)
  const task = await claimNextReady(channel, wait)
  if (!task) {
    process.stderr.write(`nothing ready for ${profile()} in ${channel}${wait ? ` within ${wait}` : ''}\n`)
    return 1
  }
  const brief = await pickupBrief(task, worktree)
  process.stdout.write(json ? JSON.stringify({ task, brief }) + '\n' : `${row(task)}\n\n${brief}\n`)
  return 0
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
    throw new Refused(`hc run failed, worktree removed: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`)
  }
}

const workerProfileOf = (t: Terminal) => {
  const agent = t.labels?.['revive.agent']
  const session = t.labels?.['revive.session']
  return agent && session && isAgent(agent) ? sessionProfile(PROFILE_PREFIX_OF_AGENT[agent], session) : null
}

async function assignToRunningWorker(task: MessageView, worker: Terminal): Promise<string> {
  const as = workerProfileOf(worker)
  if (!as) throw new Refused(`hc ${worker.address} has no revive.agent and revive.session labels to name the profile it claims as: dispatch --new`)
  try {
    await exec('node', [CLI, 'board', 'tasks', 'assign', task.id, as])
  } catch (error) {
    throw new Refused(`assigning ${task.labels.key ?? task.id} to ${as} failed, nothing recorded: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`)
  }
  return as
}

async function recordDispatchAsThisWindow(c: Checked, a: Args, address: string, worker = c.name) {
  const model = a.model ?? (a.agent === 'claude' ? CLAUDE_MODEL_WHEN_NONE_IS_NAMED : undefined)
  const value = { worker, terminal: address, accept: a.accept, orchestrator: c.orch, agent: a.agent, ...(model ? { model } : {}) }
  const why = checkValue(SCHEMAS['nawaban-dispatch@2'].schema, value)
  try {
    if (why) throw new Error(why)
    if (c.task) await board().as(c.as).reply(c.task.id, block('nawaban-dispatch@2', value))
  } catch (error) {
    throw new Refused(`dispatched to hc ${address}, but recording it on ${a.ref} failed: ${(error as Error).message}`)
  }
}

async function recordBriefThePickupReads(c: Checked, a: Args, task: MessageView, address: string) {
  try {
    await board().as(c.as).reply(task.id, `${BRIEF_NOTE}${a.brief}`)
  } catch (error) {
    throw new Refused(`assigned ${a.ref} for hc ${address}, but recording its brief failed: ${(error as Error).message}`)
  }
}

const exitCodeOf = (error: unknown) =>
  error instanceof Refused ? error.code : PARSE_ARGS_MISTAKES.includes((error as { code?: string }).code ?? '') ? 2 : 1

export async function dispatch(argv: string[]): Promise<number> {
  try {
    const a = parseDispatchArgs(argv)
    const checked = await refuseBeforeAnythingStarts(a)
    const seat = await seatFor(checked, a)
    const lane = checked.lane ? ` (lane ${checked.lane})` : ''
    if (seat.reuse) {
      const worker = seat.reuse
      const as = await assignToRunningWorker(seat.task, worker)
      await recordDispatchAsThisWindow(checked, a, worker.address, worker.name ?? worker.address)
      await recordBriefThePickupReads(checked, a, seat.task, worker.address)
      process.stdout.write(`assigned ${checked.who} to running hc ${worker.address} (profile ${as})${lane} · it claims it once its ticket is done · reports to ${checked.orch}\n`)
      return 0
    }
    const wt = await worktreeOffOriginMain(checked.root, checked.name)
    const brief = briefReportingTo(a.ref ? { ref: a.ref } : { name: checked.name, orch: checked.orch }, a.brief, a.accept, freshWorktreeLine(wt))
    const address = await startWorkerElseRemoveWorktree(checked, a, wt, brief)
    await recordDispatchAsThisWindow(checked, a, address)
    if (checked.lane) await stdoutOrNullOnFailure('hc', ['label', address, `lane=${checked.lane}`])
    const passedOver = seat.passedOver.length ? `, passed over ${seat.passedOver.join('; ')}` : ''
    process.stdout.write(`dispatched ${checked.who} → hc ${address}${lane}${passedOver} · ${wt.path} · reports to ${checked.orch}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return exitCodeOf(error)
  }
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
