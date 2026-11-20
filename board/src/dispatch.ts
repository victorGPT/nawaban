import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve as absolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { block, board } from '@vercel/board'
import { checkValue } from '@vercel/board/schemas'
import { SCHEMAS } from './schemas.ts'
import { profile, Refused, resolve } from './tasks.ts'

const exec = promisify(execFile)
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url))

/** A command's stdout, or null when it fails. */
async function out(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await exec(cmd, args, { timeout: 10_000 })).stdout
  } catch {
    return null
  }
}

/** The main checkout of the git repository `dir` is in: a worktree maps to it. */
async function repoRoot(dir: string): Promise<string | null> {
  const common = await out('git', ['-C', dir, 'rev-parse', '--git-common-dir'])
  // Real paths, so /var and /private/var (macOS) name one repository.
  return common === null ? null : dirname(await realpath(absolute(dir, common.trim())))
}

async function role(terminal: string): Promise<string | undefined> {
  const got = await out('hc', ['get', terminal, '--json'])
  try {
    return got === null ? undefined : JSON.parse(got).labels?.role
  } catch {
    return undefined
  }
}

/** This terminal if the owner labelled it role=orchestrator, else a live one in `root`'s repository so labelled. */
async function orchestrator(root: string): Promise<string | null> {
  const me = process.env.HC_TERMINAL_ID
  if (me && (await role(me)) === 'orchestrator') return me
  let terminals: { address: string; state?: string; cwd?: string }[]
  try {
    terminals = JSON.parse((await out('hc', ['ls', '--json'])) ?? '').terminals
  } catch {
    return null
  }
  for (const t of terminals) {
    if (t.state === 'live' && t.cwd && (await repoRoot(t.cwd)) === root && (await role(t.address)) === 'orchestrator') return t.address
  }
  return null
}

/**
 * `nawaban dispatch <key> --brief … --accept …`: a worker in its own worktree off origin/main, run with
 * `hc run`, briefed to report to the repository's orchestrator; the task gets a `nawaban-dispatch@1`
 * reply written as this window's profile, which is how the panel finds the task's orchestrator.
 */
export async function dispatch(argv: string[]): Promise<number> {
  try {
    const { values: a, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { name: { type: 'string' }, brief: { type: 'string' }, accept: { type: 'string' }, model: { type: 'string', default: 'opus' } },
    })
    const [ref] = positionals
    if (positionals.length > 1 || !(ref || a.name) || !a.brief || !a.accept) {
      throw new Refused('usage: nawaban dispatch [<key>] --brief "<goal, scope>" --accept "<what counts as done>" [--name <worker>] [--model opus]; no key (a nightly retro, say) takes --name and records nothing', 2)
    }
    const as = profile() // refuse before anything starts
    const task = ref ? await resolve(ref) : null
    if (task && ['completed', 'canceled', 'failed'].includes(task.task?.state ?? '')) throw new Refused(`${ref} is ${task.task?.state}, not open`)
    const root = await repoRoot(process.cwd())
    if (!root) throw new Refused('run dispatch inside the git repository the worker changes')
    const orch = await orchestrator(root)
    if (!orch) throw new Refused('no live orchestrator (a terminal labelled role=orchestrator in this repository) to take the report')
    const name = a.name ?? ref!.toLowerCase()
    const who = ref ?? name
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Refused(`--name takes 1-32 of a-z 0-9 - _: ${name}`, 2)

    const wt = `${dirname(root)}/${basename(root)}-${name}`
    const branch = `wt/${name}`
    for (const args of [['fetch', '-q', 'origin', 'main'], ['worktree', 'add', '-q', '-b', branch, wt, 'origin/main']]) {
      try {
        await exec('git', ['-C', root, ...args])
      } catch (error) {
        throw new Refused(`git ${args[0]} failed: ${String((error as { stderr?: string }).stderr ?? error).trim()}`)
      }
    }
    const nawaban = `node ${CLI}`
    const brief = [
      `/pstack:poteto-mode 任务：${ref ? `${ref}（${nawaban} show ${ref} 看全文；认领、进展、关闭用 ${nawaban} claim|event|close 记）` : name}`,
      `worktree：${wt}（分支 ${branch}，已从 origin/main 拉好；只在这里改，PR 合并或作废后 git worktree remove）`,
      a.brief,
      `验收：${a.accept}`,
      '完成或受阻：照抄其一，三段位置固定、段里的话自己写，详情记在票上：',
      `  hc send ${orch} "回报：${who} 完成 | 结论一句 | 证据在哪（PR / 票上的记录）"`,
      `  hc send ${orch} "回报：${who} 受阻 | 卡在什么 | 要谁做什么"`,
      '只发这两种：中途进展、阶段结果记在票上的「进展」里，不发给编排者（每条消息都会叫醒它，留在它的上下文里）。',
    ].join('\n')
    // The worker reaches the board this one does. ponytail: a token given only as BOARD_TOKEN isn't passed on (it'd show in ps); it reads the token file.
    const env = ['NAWABAN_BOARD_DIR', 'NAWABAN_BOARD_PORT', 'BOARD_URL'].flatMap((k) => (process.env[k] ? [`${k}=${process.env[k]}`] : []))
    let address: string
    try {
      const run = await exec('hc', ['run', '--bg', '--json', '--name', name, '--cwd', wt, ...(env.length ? ['env', ...env] : []), 'claude', '--model', a.model!, brief])
      address = JSON.parse(run.stdout).address
      if (!address) throw new Error(run.stdout)
    } catch (error) {
      await out('git', ['-C', root, 'worktree', 'remove', '--force', wt])
      await out('git', ['-C', root, 'branch', '-D', branch])
      throw new Refused(`hc run failed, worktree removed: ${String((error as { stderr?: string }).stderr || (error as Error).message).trim()}`)
    }
    const value = { worker: name, terminal: address, accept: a.accept }
    const why = checkValue(SCHEMAS['nawaban-dispatch@1'].schema, value)
    try {
      if (why) throw new Error(why)
      if (task) await board().as(as).reply(task.id, block('nawaban-dispatch@1', value))
    } catch (error) {
      throw new Refused(`dispatched to hc ${address} (${wt}), but recording it on ${ref} failed: ${(error as Error).message}`)
    }
    process.stdout.write(`dispatched ${who} → hc ${address} · ${wt} · reports to ${orch}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return error instanceof Refused ? error.code : (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? 2 : 1
  }
}
