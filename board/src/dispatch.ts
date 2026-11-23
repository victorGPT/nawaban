import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve as absolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { block, board, type MessageView } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { SCHEMAS } from './schemas.ts'
import { profile, Refused, resolve } from './tasks.ts'

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
type Agent = keyof typeof WORKER_ARGV
const isAgent = (name: string): name is Agent => Object.hasOwn(WORKER_ARGV, name)
const USAGE =
  `usage: nawaban dispatch [<key>] --brief "<goal, scope>" --accept "<what counts as done>" [--name <worker>] [--agent ${Object.keys(WORKER_ARGV).join('|')}] [--model <m>, opus for claude]; no key (a nightly retro, say) takes --name and records nothing`

type Args = { ref: string | undefined; name: string | undefined; brief: string; accept: string; agent: Agent; model: string | undefined }
type Checked = { as: string; task: MessageView | null; root: string; orch: string; name: string; who: string }
type Worktree = { path: string; branch: string }

async function stdoutOrNullOnFailure(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await exec(cmd, args, { timeout: PROBE_TIMEOUT_MS })).stdout
  } catch {
    return null
  }
}

async function mainCheckoutRealPathOf(dir: string): Promise<string | null> {
  const common = await stdoutOrNullOnFailure('git', ['-C', dir, 'rev-parse', '--git-common-dir'])
  return common === null ? null : dirname(await realpath(absolute(dir, common.trim())))
}

async function roleLabelOf(terminal: string): Promise<string | undefined> {
  const got = await stdoutOrNullOnFailure('hc', ['get', terminal, '--json'])
  try {
    return got === null ? undefined : JSON.parse(got).labels?.role
  } catch {
    return undefined
  }
}

async function thisTerminalIfOrchestrator(): Promise<string | null> {
  const me = process.env.HC_TERMINAL_ID
  return me && (await roleLabelOf(me)) === 'orchestrator' ? me : null
}

async function liveOrchestratorInRepository(root: string): Promise<string | null> {
  let terminals: { address: string; state?: string; cwd?: string }[]
  try {
    terminals = JSON.parse((await stdoutOrNullOnFailure('hc', ['ls', '--json'])) ?? '').terminals
  } catch {
    return null
  }
  for (const t of terminals) {
    if (t.state === 'live' && t.cwd && (await mainCheckoutRealPathOf(t.cwd)) === root && (await roleLabelOf(t.address)) === 'orchestrator') return t.address
  }
  return null
}

async function orchestratorFor(root: string): Promise<string | null> {
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
    },
  })
  const [ref] = positionals
  if (positionals.length > 1 || !(ref || a.name) || !a.brief || !a.accept || !isAgent(a.agent!)) throw new Refused(USAGE, 2)
  return { ref, name: a.name, brief: a.brief, accept: a.accept, agent: a.agent, model: a.model }
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
  return { as, task, root, orch, name, who }
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

function briefReportingTo(c: Checked, a: Args, wt: Worktree): string {
  const nawaban = `node ${CLI}`
  return [
    `任务：${a.ref ? `${a.ref}（${nawaban} show ${a.ref} 看全文；认领、进展、关闭用 ${nawaban} claim|event|close 记）` : c.name}`,
    `worktree：${wt.path}（分支 ${wt.branch}，已从 origin/main 拉好；只在这里改，PR 合并或作废后 git worktree remove）`,
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

async function recordDispatchAsThisWindow(c: Checked, a: Args, wt: Worktree, address: string) {
  const value = { worker: c.name, terminal: address, accept: a.accept }
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
    const wt = await worktreeOffOriginMain(checked.root, checked.name)
    const address = await startWorkerElseRemoveWorktree(checked, a, wt, briefReportingTo(checked, a, wt))
    await recordDispatchAsThisWindow(checked, a, wt, address)
    process.stdout.write(`dispatched ${checked.who} → hc ${address} · ${wt.path} · reports to ${checked.orch}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return exitCodeOf(error)
  }
}
