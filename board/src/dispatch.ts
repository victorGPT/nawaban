import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve as absolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { block, board, type MessageView } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { SCHEMAS } from './schemas.ts'
import { profile, Refused, resolve, sessionProfile } from './tasks.ts'

const exec = promisify(execFile)
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))
const PROBE_TIMEOUT_MS = 10_000
const WORKER_NAME = /^[a-z0-9_-]{1,32}$/
const PARSE_ARGS_MISTAKES = ['ERR_PARSE_ARGS_UNKNOWN_OPTION', 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE']
const CLOSED_STATES = ['completed', 'canceled', 'failed']
const ENV_NAMING_THIS_BOARD_AND_CODEX_CONFIG_NOT_THE_BOARD_TOKEN = ['NAWABAN_BOARD_DIR', 'NAWABAN_BOARD_PORT', 'BOARD_URL', 'CODEX_HOME']
const WORKER_ARGV = {
  claude: (model: string | undefined, brief: string) => ['claude', '--model', model ?? 'opus', `/pstack:poteto-mode ${brief}`],
  codex: (model: string | undefined, brief: string) => ['codex', ...(model ? ['-m', model] : []), brief],
  agy: (model: string | undefined, brief: string) => ['agy', ...(model ? ['--model', model] : []), '-i', brief],
}
const PROFILE_PREFIX_OF_AGENT = { claude: 'cc', codex: 'cx', agy: 'agy' } as const
const CLAUDE_CONTEXT_WINDOW_TOKENS = 1_000_000
const REUSE_WHILE_CONTEXT_SHARE_BELOW = 0.5
const CLAIM_LEASE_SECONDS = 3600
export const LANE_NOTE = /^\s*lane:\s*(\S.*?)\s*$/
type Agent = keyof typeof WORKER_ARGV
const isAgent = (name: string): name is Agent => Object.hasOwn(WORKER_ARGV, name)
const USAGE =
  `usage: nawaban dispatch [<key>] --brief "<goal, scope>" --accept "<what counts as done>" [--name <worker>] [--agent ${Object.keys(WORKER_ARGV).join('|')}] [--model <m>, opus for claude] [--to <terminal> | --new]; a task with a lane: note goes to that lane's live worker unless --new; no key (a nightly retro, say) takes --name and records nothing`

type Args = { ref: string | undefined; name: string | undefined; brief: string; accept: string; agent: Agent; model: string | undefined; to: string | undefined; fresh: boolean }
type Checked = { as: string; task: MessageView | null; root: string; orch: string; name: string; who: string; lane: string | null }
type Worktree = { path: string; branch: string }
type Terminal = { address: string; name?: string; state?: string; cwd?: string; argv?: string[]; labels?: Record<string, string> }
type Seat = { reuse: Terminal } | { reuse: null; passedOver: string[] }

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

async function liveTerminalsInRepository(root: string): Promise<Terminal[]> {
  let terminals: Terminal[]
  try {
    terminals = JSON.parse((await stdoutOrNullOnFailure('hc', ['ls', '--json'])) ?? '').terminals
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
  const startedWith = (t.argv ?? []).slice(-want.length - 1, -1)
  return startedWith.length === want.length && want.every((w, i) => startedWith[i] === w)
}

async function claudeTranscriptOf(session: string): Promise<string | null> {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const dirs = await readdir(projects).catch(() => [])
  const found = dirs.map((d) => join(projects, d, `${session}.jsonl`)).find((f) => existsSync(f))
  return found ?? null
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
    const t = await terminalOf(a.to)
    if (t?.state !== 'live' || !t.cwd || (await mainCheckoutRealPathOf(t.cwd)) !== c.root) throw new Refused(`--to ${a.to} is no live terminal in this repository`)
    return { reuse: t }
  }
  if (a.fresh || !c.lane) return { reuse: null, passedOver: [] }
  const passedOver: string[] = []
  for (const t of await laneWorkersInRepository(c.root, c.lane)) {
    const share = await contextShareOf(t)
    if (!startsTheWayThisDispatchWould(t, a)) passedOver.push(`${t.address} runs another agent or model`)
    else if (share !== null && share >= REUSE_WHILE_CONTEXT_SHARE_BELOW) passedOver.push(`${t.address} has used ${Math.round(share * 100)}% of its context`)
    else return { reuse: t }
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

const MERGE_LINE = `收尾：验收没说不合并时，PR 的 CI 绿、评论里贴了带 head sha 的「Codex review：无挡…」之后，跑 node ${CLI} merge <PR 号>，它合并、关票、交下一张或收掉你`

const freshWorktreeLine = (wt: Worktree) =>
  `worktree：${wt.path}（分支 ${wt.branch}，已从 origin/main 拉好；只在这里改。同一泳道的下一张可能接着派到这个终端，worktree 留着）。${MERGE_LINE}`

const reusedWorktreeLine = (wt: Worktree) =>
  `worktree：接着用 ${wt.path}。手上那张做完、回报后再开工：git fetch origin main && git switch -c ${wt.branch} origin/main，只在这个分支上改。${MERGE_LINE}`

function briefReportingTo(c: Checked, a: Args, worktreeLine: string): string {
  const nawaban = `node ${CLI}`
  return [
    `任务：${a.ref ? `${a.ref}（${nawaban} show ${a.ref} 看全文；认领、进展、关闭用 ${nawaban} claim|event|close 记）` : c.name}`,
    worktreeLine,
    a.brief,
    `验收：${a.accept}`,
    '完成或受阻：照抄其一，三段位置固定、段里的话自己写，详情记在票上：',
    `  hc send ${c.orch} "回报：${c.who} 完成 | 结论一句 | 证据在哪（PR / 票上的记录）"`,
    `  hc send ${c.orch} "回报：${c.who} 受阻 | 卡在什么 | 要谁做什么"`,
    '只发这两种：中途进展、阶段结果记在票上的「进展」里，不发给编排者（每条消息都会叫醒它，留在它的上下文里）。',
  ].join('\n')
}

const envReachingThisBoardWithoutToken = () => ENV_NAMING_THIS_BOARD_AND_CODEX_CONFIG_NOT_THE_BOARD_TOKEN.flatMap((k) => (process.env[k] ? [`${k}=${process.env[k]}`] : []))

async function startWorkerElseRemoveWorktree(c: Checked, a: Args, wt: Worktree, brief: string): Promise<string> {
  const env = envReachingThisBoardWithoutToken()
  try {
    const run = await exec('hc', ['run', '--bg', '--json', '--name', c.name, '--cwd', wt.path, ...(env.length ? ['env', ...env] : []), ...WORKER_ARGV[a.agent](a.model, brief)])
    const address = JSON.parse(run.stdout).address
    if (!address) throw new Error(run.stdout)
    return address
  } catch (error) {
    await stdoutOrNullOnFailure('git', ['-C', c.root, 'worktree', 'remove', '--force', wt.path])
    await stdoutOrNullOnFailure('git', ['-C', c.root, 'branch', '-D', wt.branch])
    throw new Refused(`hc run failed, worktree removed: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`)
  }
}

async function handToRunningWorker(c: Checked, a: Args, worker: Terminal): Promise<Worktree> {
  const wt = { path: worker.cwd!, branch: `wt/${c.name}` }
  const message = WORKER_ARGV[a.agent](a.model, briefReportingTo(c, a, reusedWorktreeLine(wt))).at(-1)!
  try {
    await exec('hc', ['send', worker.address, message])
  } catch (error) {
    throw new Refused(`hc send to ${worker.address} failed, nothing recorded: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`)
  }
  return wt
}

const workerProfileOf = (t: Terminal) => {
  const agent = t.labels?.['revive.agent']
  const session = t.labels?.['revive.session']
  return agent && session && isAgent(agent) ? sessionProfile(PROFILE_PREFIX_OF_AGENT[agent], session) : null
}

async function claimForWorkerIfReady(task: MessageView, worker: Terminal): Promise<boolean> {
  const as = workerProfileOf(worker)
  if (!as) return false
  try {
    await board().as(as).tasks.claim(task.id, { lease: CLAIM_LEASE_SECONDS })
    await board().as(null).label(task.id, { set: { terminal: worker.address } })
    return true
  } catch {
    return false
  }
}

async function recordDispatchAsThisWindow(c: Checked, a: Args, wt: Worktree, address: string, worker = c.name) {
  const value = { worker, terminal: address, accept: a.accept }
  const why = checkValue(SCHEMAS['nawaban-dispatch@1'].schema, value)
  try {
    if (why) throw new Error(why)
    if (c.task) await board().as(c.as).reply(c.task.id, block('nawaban-dispatch@1', value))
  } catch (error) {
    throw new Refused(`dispatched to hc ${address} (${wt.path}), but recording it on ${a.ref} failed: ${(error as Error).message}`)
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
      const wt = await handToRunningWorker(checked, a, worker)
      await recordDispatchAsThisWindow(checked, a, wt, worker.address, worker.name ?? worker.address)
      const claimed = checked.task ? await claimForWorkerIfReady(checked.task, worker) : false
      const claim = checked.task ? (claimed ? ' · claimed for it' : ' · it claims when it starts') : ''
      process.stdout.write(`handed ${checked.who} to running hc ${worker.address}${lane} · ${wt.path} · branch ${wt.branch} on its next turn${claim} · reports to ${checked.orch}\n`)
      return 0
    }
    const wt = await worktreeOffOriginMain(checked.root, checked.name)
    const address = await startWorkerElseRemoveWorktree(checked, a, wt, briefReportingTo(checked, a, freshWorktreeLine(wt)))
    await recordDispatchAsThisWindow(checked, a, wt, address)
    if (checked.lane) await stdoutOrNullOnFailure('hc', ['label', address, `lane=${checked.lane}`])
    const passedOver = seat.passedOver.length ? `, passed over ${seat.passedOver.join('; ')}` : ''
    process.stdout.write(`dispatched ${checked.who} → hc ${address}${lane}${passedOver} · ${wt.path} · reports to ${checked.orch}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return exitCodeOf(error)
  }
}
