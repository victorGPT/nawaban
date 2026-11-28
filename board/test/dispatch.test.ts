import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { pathsIn, workerTitle } from '../src/dispatch.ts'
import { registerSchemas } from '../src/schemas.ts'
import { listen, verifier } from '../src/server.ts'
import { stable } from './stable.ts'

const exec = promisify(execFile)
const CLI = join(import.meta.dirname, '../src/cli.ts')
const SECRET = 'test-secret'
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let url = ''
let tmp = ''
let repo = ''

const HC_STAND_IN_LOGGING_CALLS_KNOWING_ONE_ORCHESTRATOR_AND_ANY_WORKER_FILED_IN_HC_WORKERS_STARTING_T99 = `#!/bin/sh
printf '%s\\n' "$*" >> "$HC_LOG"
case "$1" in
  get) if [ -n "$HC_ORCH" ] && [ "$2" = "$HC_ORCH" ]; then echo '{"labels":{"role":"orchestrator"}}'; elif [ -f "$HC_WORKERS/$2.json" ]; then cat "$HC_WORKERS/$2.json"; else echo '{"labels":{}}'; fi ;;
  ls) if [ -n "$HC_ORCH" ]; then echo "{\\"terminals\\":[{\\"address\\":\\"$HC_ORCH\\",\\"state\\":\\"live\\",\\"cwd\\":\\"$HC_ORCH_CWD\\"}$HC_LS_WORKERS]}"; else echo '{"terminals":[]}'; fi ;;
  run) if [ -n "$HC_RUN_FAIL" ]; then echo 'no core' >&2; exit 1; fi; echo '{"address":"t99"}' ;;
  send) if [ -n "$HC_SEND_FAIL" ]; then echo 'no such terminal' >&2; exit 1; fi ;;
esac
`

const GH_STAND_IN_ANSWERING_MERGED_PULL_REQUEST_FILES_FROM_GH_MERGED = `#!/bin/sh
printf 'gh %s token=%s\\n' "$*" "$GH_TOKEN" >> "$HC_LOG"
[ "$1 $2" = 'auth token' ] && { echo "tok-$4"; exit 0; }
branch=$(printf '%s' "$*" | sed -n 's/.*--head \\([^ ]*\\).*/\\1/p')
files="$GH_MERGED/$(printf '%s' "$branch" | tr / _)"
[ -n "$branch" ] && [ -f "$files" ] && cat "$files"
exit 0
`

const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args])

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'nawaban-dispatch-')))
  await writeFile(join(tmp, 'hc'), HC_STAND_IN_LOGGING_CALLS_KNOWING_ONE_ORCHESTRATOR_AND_ANY_WORKER_FILED_IN_HC_WORKERS_STARTING_T99)
  await chmod(join(tmp, 'hc'), 0o755)
  await writeFile(join(tmp, 'gh'), GH_STAND_IN_ANSWERING_MERGED_PULL_REQUEST_FILES_FROM_GH_MERGED)
  await chmod(join(tmp, 'gh'), 0o755)
  await exec('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')])
  repo = join(tmp, 'repo')
  await exec('git', ['clone', '-q', join(tmp, 'origin.git'), repo])
  await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  await git(repo, 'push', '-q', 'origin', 'HEAD:main')
})
afterAll(() => server.close())

const dispatchInTheRepositoryAsWindowAaaa1111 = (argv: string[], hc: Record<string, string>) => nawabanInTheRepositoryAsWindowAaaa1111('dispatch', argv, hc)

async function nawabanInTheRepositoryAsWindowAaaa1111(verb: string, argv: string[], hc: Record<string, string>) {
  const log = join(tmp, `hc-${Math.random()}.log`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tmp}:${process.env.PATH}`,
    BOARD_URL: url,
    BOARD_TOKEN: SECRET,
    XDG_CONFIG_HOME: tmp,
    CLAUDE_CODE_SESSION_ID: 'aaaa1111-0000',
    HC_TERMINAL_ID: 'tme',
    HC_LOG: log,
    HC_ORCH: '',
    HC_ORCH_CWD: repo,
    HC_RUN_FAIL: '',
    HC_SEND_FAIL: '',
    HC_WORKERS: join(tmp, 'workers'),
    HC_LS_WORKERS: '',
    GH_MERGED: join(tmp, 'merged'),
    CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
    CODEX_HOME: '',
    ...hc,
  }
  for (const thisMachinesBoardSetting of ['NAWABAN_BOARD_DIR', 'NAWABAN_BOARD_PORT']) delete env[thisMachinesBoardSetting]
  const r = await exec('node', [CLI, verb, ...argv], { cwd: repo, env }).then(
    (ok) => ({ code: 0, ...ok }),
    (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }),
  )
  return { ...r, hc: existsSync(log) ? await readFile(log, 'utf8') : '' }
}

const newTask = async (key: string) => (await team.as(null).tasks.create('nawaban', { id: key, text: key, labels: { key } })).task.id
const replies = async (id: string) => (await team.thread(id)).replies

it('refuses to dispatch with no live orchestrator, and starts nothing', async () => {
  const id = await newTask('D-NONE')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-NONE', '--brief', 'b', '--accept', 'a'], {})
  expect(r.code).toBe(1)
  expect(r.stderr).toMatchInlineSnapshot(`
    "✗ 没有活着的编排者收回报
      在本仓库的编排者终端里跑，或给它打上 role=orchestrator 标签
    "
  `)
  expect(r.hc).not.toMatch(/^run/m)
  expect(existsSync(join(tmp, 'repo-d-none'))).toBe(false)
  expect(await replies(id)).toEqual([])
})

it('prints one object for --json', async () => {
  await newTask('D-JSON')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-JSON', '--brief', 'b', '--accept', 'a', '--json'], { HC_ORCH: 'to1' })
  expect([r.code, r.stderr]).toEqual([0, ''])
  expect(JSON.parse(r.stdout)).toMatchObject({ ticket: 'D-JSON', terminal: 't99', worktree: join(tmp, 'repo-d-json'), orchestrator: 'to1', assigned: false })
})

it('starts the worker in its own worktree, briefed to report to the orchestrator, and records it as this window', async () => {
  const id = await newTask('D-GO')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-GO', '--brief', 'do it', '--accept', 'it is done'], { HC_ORCH: 'to1' })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(stable(r.stdout, tmp)).toMatchInlineSnapshot(`
    "✓ 派出 D-GO → hc t99 · <tmp>/repo-d-go · 回报给 to1
    "
  `)
  const run = r.hc.slice(r.hc.indexOf('run --bg'))
  expect(run).toMatch(/^run --bg --outlive-parent --json --name d-go /)
  expect(run).toContain(`--name d-go --cwd ${join(tmp, 'repo-d-go')} env BOARD_URL=${url} claude -n D-GO D-GO --model opus`)
  expect(run).toContain(`nawaban tell D-GO "完成 PR #<号>"`)
  expect(run).toContain(`nawaban tell D-GO "受阻，详情在票上"`)
  expect(run).toContain('nawaban merge <PR 号>')
  expect(run).toContain('只在 wt/d-go 上提交和开 PR，不另开分支')
  expect(run).not.toContain('cli.ts')
  expect(run).not.toContain('to1')
  expect((await git(join(tmp, 'repo-d-go'), 'branch', '--show-current')).stdout.trim()).toBe('wt/d-go')
  const [reply] = await replies(id)
  expect(reply?.author).toMatchObject({ kind: 'agent', handle: 'victor/cc-aaaa1111' })
  expect(reply?.blocks).toMatchObject([{ schema: 'nawaban-dispatch', data: { worker: 'd-go', terminal: 't99', accept: 'it is done', orchestrator: 'to1', agent: 'claude', model: 'opus' } }])
})

it('puts back in the pool a ticket still kept for another profile before a fresh worker starts on it, so the fresh worker can claim it', async () => {
  const id = await newTask('D-KEPT')
  await team.tasks.assign(id, `${(await team.thread(id)).message.task!.owner}+cc-gone0000`)
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-KEPT', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect((await team.thread(id)).message.task?.for).toBeNull()
  expect((await team.as('cc-fresh000').tasks.claim(id)).task.task?.claim?.actor).toMatch(/cc-fresh000$/)
})

it('keeps a ticket kept for another profile when the fresh worker fails to start', async () => {
  const id = await newTask('D-KEPTFAIL')
  const keptFor = `${(await team.thread(id)).message.task!.owner}+cc-gone0000`
  await team.tasks.assign(id, keptFor)
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-KEPTFAIL', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1', HC_RUN_FAIL: '1' })
  expect(r.code).toBe(1)
  expect((await team.thread(id)).message.task?.for).toBe(keptFor)
})

it.each([
  { title: 'perf(api): 主模型窗口按实测调大', tag: '#1700', named: '【api】主模型窗口按实测调大 #1700' },
  { title: '每晚复盘 2026-11-23', tag: '#1657', named: '每晚复盘 2026-11-23 #1657' },
  { title: 'fix: 无 scope 的前缀只去掉', tag: 'P-01', named: '无 scope 的前缀只去掉 P-01' },
  { title: 'feat(web): 一二三四五六七八九十一二三四五六七八九十一二三四五六', tag: 'NAWABAN-X', named: '【web】一二三四五六七八九十一二三四五六七八九十一二三四… NAWABAN-X' },
])('names the worker $named', ({ title, tag, named }) => {
  expect(workerTitle(title, tag)).toBe(named)
})

it('names a board-tracked worker by its title and task id from the start', async () => {
  await team.as(null).tasks.create('nawaban', { id: 'D-NAMED', text: 'perf(api): 主模型窗口按实测调大\n\nbody', labels: { key: 'D-NAMED' } })
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-NAMED', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(0)
  expect(r.hc).toContain('claude -n 【api】主模型窗口按实测调大 D-NAMED --model opus /pstack:poteto-mode')
})

it('removes the worktree and records nothing when hc run fails', async () => {
  const id = await newTask('D-FAIL')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-FAIL', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1', HC_RUN_FAIL: '1' })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('hc run 失败，worktree 已删')
  expect(existsSync(join(tmp, 'repo-d-fail'))).toBe(false)
  expect((await git(repo, 'branch', '--list', 'wt/d-fail')).stdout).toBe('')
  expect(await replies(id)).toEqual([])
})

it('dispatches with no task, under --name, and records nothing', async () => {
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'retro', '--brief', 'nightly retro', '--accept', 'a retro'], { HC_ORCH: 'to1' })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.hc).toContain('/pstack:poteto-mode 任务：retro\n')
  expect(r.hc).toContain('hc send to1 "回报：retro 完成')
  expect(r.hc).not.toContain('跑 nawaban merge')
  expect(r.hc).toContain('按仓库文档（如 docs/agents/review.md）的合并方式合')
  expect(existsSync(join(tmp, 'repo-retro'))).toBe(true)
})

it.each([
  { agent: [], model: [], starts: 'claude -n row-default --model opus /pstack:poteto-mode 任务：row-default\n' },
  { agent: ['--agent', 'claude'], model: ['--model', 'sonnet'], starts: 'claude -n row-claude --model sonnet /pstack:poteto-mode 任务：row-claude\n' },
  { agent: ['--agent', 'codex'], model: [], starts: 'codex 任务：row-codex\n' },
  { agent: ['--agent', 'codex'], model: ['--model', 'gpt-5.5'], starts: 'codex -m gpt-5.5 任务：row-codex-m\n' },
  { agent: ['--agent', 'agy'], model: [], starts: 'agy -i 任务：row-agy\n' },
  { agent: ['--agent', 'agy'], model: ['--model', 'gemini-4'], starts: 'agy --model gemini-4 -i 任务：row-agy-m\n' },
])('starts $starts', async ({ agent, model, starts }) => {
  const name = starts.slice(starts.indexOf('任务：') + 3, -1)
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', name, ...agent, ...model, '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.hc).toContain(`--name ${name} --cwd ${join(tmp, `repo-${name}`)} env BOARD_URL=${url} ${starts}`)
})

it('hands the worker the Codex config the dispatcher runs under', async () => {
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'cx-home', '--agent', 'codex', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1', CODEX_HOME: '/tmp/cx' })
  expect(r.code).toBe(0)
  expect(r.hc).toContain(`env BOARD_URL=${url} CODEX_HOME=/tmp/cx codex 任务：cx-home`)
})

it('refuses --agent with no value as a usage mistake', async () => {
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'row-none', '--brief', 'b', '--accept', 'a', '--agent'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(2)
  expect(r.hc).toBe('')
})

it('refuses an agent it has no row for, and starts nothing', async () => {
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'row-gemini', '--agent', 'gemini', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('--agent claude|codex|agy')
  expect(r.hc).toBe('')
  expect(existsSync(join(tmp, 'repo-row-gemini'))).toBe(false)
})

const LANE_WORKER = 't99'
const WORKER_SESSION = 'bbbb2222-0000'

async function fileTheLaneWorkerAt(worktree: string, lane: string, contextTokens: number, startedAs = ['claude', '--model', 'opus'], status = 'working') {
  await mkdir(join(tmp, 'workers'), { recursive: true })
  await writeFile(
    join(tmp, 'workers', `${LANE_WORKER}.json`),
    JSON.stringify({
      state: 'live',
      name: 'first-of-lane',
      cwd: worktree,
      argv: ['env', `BOARD_URL=${url}`, ...startedAs, '/pstack:poteto-mode 任务：A'],
      labels: { lane, 'revive.agent': 'claude', 'revive.session': WORKER_SESSION },
      status: { app: 'claude-code', state: status },
    }),
  )
  await mkdir(join(tmp, 'claude', 'projects', 'worker'), { recursive: true })
  const turn = (usage: object, isSidechain = false) => JSON.stringify({ type: 'assistant', isSidechain, message: { usage } })
  await writeFile(
    join(tmp, 'claude', 'projects', 'worker', `${WORKER_SESSION}.jsonl`),
    [turn({ input_tokens: 1, cache_read_input_tokens: 10 }), turn({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: contextTokens - 1002 }), turn({ input_tokens: 900_000 }, true), ''].join('\n'),
  )
  return { HC_ORCH: 'to1', HC_LS_WORKERS: `,{"address":"${LANE_WORKER}","state":"live","cwd":"${worktree}"}` }
}

const note = (id: string, text: string) => team.as('cc-orch0000').reply(id, text)

async function laneOfTwoWhereFirstBlocksSecond(prefix: string, lane: string, secondLane = lane) {
  const first = await newTask(`${prefix}-A`)
  const second = (await team.as(null).tasks.create('nawaban', { id: `${prefix}-B`, text: `${prefix}-B`, labels: { key: `${prefix}-B` }, needs: [first] })).task.id
  await note(first, `lane: ${lane}`)
  await note(second, `lane: ${secondLane}`)
  const a = await dispatchInTheRepositoryAsWindowAaaa1111([`${prefix}-A`, '--brief', 'first', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(a.stderr).toBe('')
  expect(a.hc).toContain(`label t99 lane=${lane}`)
  return { first, second, worktree: join(tmp, `repo-${prefix.toLowerCase()}-a`) }
}

const claimAs = (session: string, ref: string) =>
  exec('node', [CLI, 'claim', ref], { cwd: repo, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, NAWABAN_BOARD_DIR: tmp, CLAUDE_CODE_SESSION_ID: session, HC_TERMINAL_ID: '' } }).then(
    (ok) => ({ code: 0, ...ok }),
    (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }),
  )

const cliAsWindowOf = (session: string, argv: string[]) =>
  exec('node', [CLI, ...argv], { cwd: repo, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, NAWABAN_BOARD_DIR: tmp, CLAUDE_CODE_SESSION_ID: session, HC_TERMINAL_ID: '' } })

it('assigns the next task of a lane to the worker running it, which alone may claim it, and pushes it nothing', async () => {
  const made = async (key: string, ...more: string[]) => JSON.parse((await cliAsWindowOf('orch0000-0000', ['create', key, '--priority', 'P2', '--title', key, '--project', 'nawaban', '--json', ...more])).stdout).task.id as string
  const first = await made('LN-A')
  const second = await made('LN-B', '--blocked-by', 'LN-A')
  await note(first, 'lane: board')
  await note(second, 'lane: board')
  expect((await dispatchInTheRepositoryAsWindowAaaa1111(['LN-A', '--brief', 'first', '--accept', 'a'], { HC_ORCH: 'to1' })).stderr).toBe('')
  const worktree = join(tmp, 'repo-ln-a')
  await cliAsWindowOf(WORKER_SESSION, ['claim', 'LN-A'])
  await cliAsWindowOf(WORKER_SESSION, ['close', 'LN-A', '--done'])
  const hc = await fileTheLaneWorkerAt(worktree, 'board', 300_000)
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LN-B', '--brief', 'second', '--accept', 'b done'], hc)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.stdout).toBe('✓ LN-B 指派给在跑的 hc t99（泳道 board），它做完手上那张自己领 · 回报给 to1\n')
  expect(r.hc).not.toMatch(/^(run|send)/m)
  expect(r.stdout + r.hc).not.toContain('next turn')
  expect(existsSync(join(tmp, 'repo-ln-b'))).toBe(false)
  expect((await team.thread(second)).message.task?.claim ?? null).toBeNull()
  expect((await replies(second)).slice(-2).map((m) => m.blocks[0]?.data ?? m.text)).toMatchObject([{ worker: 'first-of-lane', terminal: 't99', accept: 'b done' }, '派发 brief：second'])
  const another = await claimAs('cccc3333-0000', 'LN-B')
  expect(another.code).toBe(1)
  expect(another.stderr).toContain("It's assigned to another profile")
  expect((await claimAs(WORKER_SESSION, 'LN-B')).code).toBe(0)
  expect((await team.thread(second)).message.task?.claim?.actor).toMatch(/\+cc-bbbb2222$/)
  const closedByTheWorker = await exec('node', [CLI, 'close', 'LN-B', '--done'], {
    cwd: worktree,
    env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, NAWABAN_BOARD_DIR: tmp, CLAUDE_CODE_SESSION_ID: WORKER_SESSION, HC_TERMINAL_ID: '' },
  })
  expect(closedByTheWorker.stdout).toBe('✓ 关了 LN-B（做完）\n')
  expect((await team.thread(second)).message.task?.state).toBe('completed')
})

it('routes a ticket made with create --lane to that lane\'s running worker, with no lane note', async () => {
  const made = async (key: string) => JSON.parse((await cliAsWindowOf('orch0000-0000', ['create', key, '--priority', 'P2', '--title', key, '--project', 'nawaban', '--lane', 'cli', '--json'])).stdout).task.id as string
  const first = await made('LL-A')
  const second = await made('LL-B')
  expect((await team.thread(second)).message.labels.lane).toBe('cli')
  const a = await dispatchInTheRepositoryAsWindowAaaa1111(['LL-A', '--brief', 'first', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(a.stderr).toBe('')
  expect(a.hc).toContain('label t99 lane=cli')
  await cliAsWindowOf(WORKER_SESSION, ['claim', 'LL-A'])
  await cliAsWindowOf(WORKER_SESSION, ['close', 'LL-A', '--done'])
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LL-B', '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(join(tmp, 'repo-ll-a'), 'cli', 10_000))
  expect(r.stderr).toBe('')
  expect(r.stdout).toBe('✓ LL-B 指派给在跑的 hc t99（泳道 cli），它做完手上那张自己领 · 回报给 to1\n')
  expect((await team.thread(first)).message.task?.state).toBe('completed')
})

it('wakes an idle worker holding no ticket to claim the one assigned to it now', async () => {
  const { worktree } = await laneOfTwoWhereFirstBlocksSecond('LW', 'wake')
  await cliAsWindowOf(WORKER_SESSION, ['claim', 'LW-A'])
  await cliAsWindowOf(WORKER_SESSION, ['close', 'LW-A', '--done'])
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LW-B', '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(worktree, 'wake', 10_000, undefined, 'done'))
  expect(r.stderr).toBe('')
  expect(r.stdout).toBe('✓ LW-B 指派给在跑的 hc t99（泳道 wake），它空着，已叫它现在领 · 回报给 to1\n')
  expect(r.hc).toMatch(/^send t99 LW-B 指派给你了：跑 nawaban claim --ready 领它/m)
})

it('leaves an idle worker still holding a ticket to claim the assigned one when it finishes', async () => {
  const { worktree } = await laneOfTwoWhereFirstBlocksSecond('LH', 'hold')
  await cliAsWindowOf(WORKER_SESSION, ['claim', 'LH-A'])
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LH-B', '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(worktree, 'hold', 10_000, undefined, 'idle'))
  expect(r.stderr).toBe('')
  expect(r.stdout).toContain('它做完手上那张自己领')
  expect(r.hc).not.toMatch(/^send/m)
})

it('leaves an idle worker unwoken while the ticket assigned to it is still blocked, so claim --ready takes nothing else', async () => {
  const { worktree } = await laneOfTwoWhereFirstBlocksSecond('LK', 'blocked')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LK-B', '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(worktree, 'blocked', 10_000, undefined, 'done'))
  expect(r.stderr).toBe('')
  expect(r.stdout).toContain('它做完手上那张自己领')
  expect(r.hc).not.toMatch(/^send/m)
})

it('assigns a task still blocked in its lane to the same worker and leaves the claim to it', async () => {
  const { second, worktree } = await laneOfTwoWhereFirstBlocksSecond('LQ', 'queue')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LQ-B', '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(worktree, 'queue', 10_000))
  expect(r.stderr).toBe('')
  expect(r.stdout).toContain('✓ LQ-B 指派给在跑的 hc t99（泳道 queue）')
  expect(r.hc).not.toMatch(/^send/m)
  expect((await team.thread(second)).message.task?.claim ?? null).toBeNull()
  expect((await replies(second)).find((m) => m.blocks.length)?.blocks).toMatchObject([{ schema: 'nawaban-dispatch', data: { terminal: 't99' } }])
})

it('refuses --to with no ticket to assign, and starts nothing', async () => {
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'to-none', '--to', 't99', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(2)
  expect(r.hc).not.toMatch(/^(run|send)/m)
  expect(existsSync(join(tmp, 'repo-to-none'))).toBe(false)
})

it('refuses to assign to a running worker whose profile its labels do not name, and records nothing', async () => {
  const id = await newTask('D-NOPROF')
  const worktree = join(tmp, 'repo-d-noprof-w')
  await git(repo, 'worktree', 'add', '-q', '-b', 'wt/d-noprof-w', worktree, 'main')
  await mkdir(join(tmp, 'workers'), { recursive: true })
  await writeFile(join(tmp, 'workers', 't93.json'), JSON.stringify({ state: 'live', name: 'anon', cwd: worktree, labels: {} }))
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-NOPROF', '--to', 't93', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('加 --new')
  expect(await replies(id)).toEqual([])
})

it.each([
  { why: 'its worker has used half its context', lane: 'half', secondLane: 'half', tokens: 500_000, argv: [], passedOver: 't99 上下文已用 50%' },
  { why: 'it is in another lane', lane: 'one', secondLane: 'other', tokens: 10_000, argv: [], passedOver: undefined },
  { why: 'it asks for another model', lane: 'model', secondLane: 'model', tokens: 10_000, argv: ['--model', 'sonnet'], passedOver: 't99 跑的是别的 agent 或模型' },
  { why: 'it asks for Codex on its default model and the worker runs another', lane: 'cxm', secondLane: 'cxm', tokens: 10_000, argv: ['--agent', 'codex'], startedAs: ['codex', '-m', 'other'], passedOver: 't99 跑的是别的 agent 或模型' },
  { why: '--new asks for parallel work', lane: 'par', secondLane: 'par', tokens: 10_000, argv: ['--new'], passedOver: undefined },
])('starts a new worker when $why', async ({ lane, secondLane, tokens, argv, passedOver, startedAs }) => {
  const prefix = `LF${lane.toUpperCase()}`
  const { worktree } = await laneOfTwoWhereFirstBlocksSecond(prefix, lane, secondLane)
  const r = await dispatchInTheRepositoryAsWindowAaaa1111([`${prefix}-B`, ...argv, '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(worktree, lane, tokens, startedAs))
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.hc).toMatch(/^run --bg/m)
  expect(r.hc).not.toMatch(/^send/m)
  expect(r.stdout).toContain(`✓ 派出 ${prefix}-B → hc t99（泳道 ${secondLane}）`)
  if (passedOver) expect(r.stdout).toContain(passedOver)
  expect(existsSync(join(tmp, `repo-${prefix.toLowerCase()}-b`))).toBe(true)
})

it('refuses --to a terminal outside this repository, and starts nothing', async () => {
  await newTask('D-TO')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-TO', '--to', 'tnowhere', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('--to tnowhere 不是本仓库里活着的终端')
  expect(r.hc).not.toMatch(/^(run|send)/m)
})

const dispatchedBy = async (key: string, orchestrator: string) => {
  const id = await newTask(key)
  await note(id, block('nawaban-dispatch@2', { worker: key.toLowerCase(), terminal: 't98', accept: 'a', orchestrator, agent: 'claude', model: 'opus' }))
  return id
}

async function fileTerminal(address: string, labels: Record<string, string>, state = 'live') {
  await mkdir(join(tmp, 'workers'), { recursive: true })
  await writeFile(join(tmp, 'workers', `${address}.json`), JSON.stringify({ state, name: address, cwd: tmp, labels }))
}

const tellAsWorker = (argv: string[], hc: Record<string, string>) => nawabanInTheRepositoryAsWindowAaaa1111('tell', argv, { HC_TERMINAL_ID: 't98', ...hc })
const sent = (hc: string) => hc.match(/^send .*$/gm) ?? []

it('tells the live orchestrator of this repository', async () => {
  const id = await dispatchedBy('T-HERE', 'tgone')
  const r = await tellAsWorker(['T-HERE', '完成 PR #5'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(0)
  expect(sent(r.hc)).toEqual(['send to1 回报：T-HERE 完成 PR #5'])
  expect((await replies(id)).map((m) => m.text)).not.toContainEqual(expect.stringContaining('回报未送达'))
})

it('tells the new orchestrator of this repository, not the one the dispatch recorded', async () => {
  await fileTerminal('tolda', { role: 'orchestrator' })
  await dispatchedBy('T-SWAP', 'tolda')
  const r = await tellAsWorker(['T-SWAP', '受阻，详情在票上'], { HC_ORCH: 'tnewb' })
  expect(r.code).toBe(0)
  expect(sent(r.hc)).toEqual(['send tnewb 回报：T-SWAP 受阻，详情在票上'])
})

it('tells the orchestrator the dispatch recorded when this repository has none but it lives on, still labelled', async () => {
  await fileTerminal('toutside', { role: 'orchestrator' })
  await dispatchedBy('T-REC', 'toutside')
  const r = await tellAsWorker(['T-REC', '完成 PR #6'], {})
  expect(r.code).toBe(0)
  expect(sent(r.hc)).toEqual(['send toutside 回报：T-REC 完成 PR #6'])
})

it.each([
  { why: 'the recorded orchestrator is no orchestrator any more', key: 'T-UNLABELLED', recorded: 'tdemoted', filed: { labels: {} as Record<string, string>, state: 'live' }, hc: {} as Record<string, string>, says: '没找到活着的编排者' },
  { why: 'the recorded orchestrator is gone', key: 'T-GONE', recorded: 'tclosed', filed: { labels: { role: 'orchestrator' }, state: 'finished' }, hc: {}, says: '没找到活着的编排者' },
  { why: 'hc send fails', key: 'T-SENDFAIL', recorded: 'tgone', filed: null, hc: { HC_ORCH: 'to1', HC_SEND_FAIL: '1' }, says: 'hc send to1 失败' },
])('notes the report on the ticket and exits 0 when $why', async ({ key, recorded, filed, hc, says }) => {
  if (filed) await fileTerminal(recorded, filed.labels, filed.state)
  const id = await dispatchedBy(key, recorded)
  const r = await tellAsWorker([key, '完成 PR #7'], hc)
  expect(r.code).toBe(0)
  expect(r.stderr).toContain(says)
  expect((await replies(id)).at(-1)?.text).toBe('回报未送达：完成 PR #7')
})

it('does not tell its own terminal when that is the orchestrator of another repository', async () => {
  await fileTerminal('t98', { role: 'orchestrator' })
  const id = await dispatchedBy('T-ELSEWHERE', 'tgone')
  const r = await tellAsWorker(['T-ELSEWHERE', '完成 PR #10'], {})
  expect(r.code).toBe(0)
  expect(sent(r.hc)).toEqual([])
  expect((await replies(id)).at(-1)?.text).toBe('回报未送达：完成 PR #10')
})

it('lists a worker in the main checkout by the ticket it holds, and leaves out a terminal there that holds none', async () => {
  await mkdir(join(tmp, 'workers'), { recursive: true })
  for (const [address, name] of [['t95', 'w-main'], ['t94', 'a-shell']]) {
    await writeFile(join(tmp, 'workers', `${address}.json`), JSON.stringify({ state: 'live', name, cwd: repo, labels: {} }))
  }
  const id = await newTask('T-MAIN')
  await note(id, block('nawaban-dispatch@2', { worker: 'w-main', terminal: 't95', accept: 'a', orchestrator: 'to1', agent: 'claude', model: 'opus' }))
  const ls = `,{"address":"t95","state":"live","cwd":"${repo}"},{"address":"t94","state":"live","cwd":"${repo}"}`
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('status', ['--project', 'nawaban'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('- t95 w-main T-MAIN\n')
  expect(r.stdout).not.toMatch(/^- t94/m)
})

it('refuses to tell about a ticket that does not exist', async () => {
  const r = await tellAsWorker(['T-NOSUCH', '完成 PR #8'], { HC_ORCH: 'to1' })
  expect(r.code).not.toBe(0)
  expect(r.stderr).toContain('没有票 T-NOSUCH')
  expect(sent(r.hc)).toEqual([])
})

it('shows an undelivered report as the progress of the ticket in status', async () => {
  const id = await dispatchedBy('T-SEEN', 'tgone')
  await team.as('cc-aaaa1111').tasks.claim(id, { lease: 3600 })
  expect((await tellAsWorker(['T-SEEN', '完成 PR #9'], {})).code).toBe(0)
  const status = await nawabanInTheRepositoryAsWindowAaaa1111('status', ['--project', 'nawaban'], {})
  expect(status.stdout).toContain('- T-SEEN T-SEEN · 回报未送达：完成 PR #9')
})

it('lists the live workers of this repository with the tickets they hold in status, and leaves the orchestrator out', async () => {
  const worktree = join(tmp, 'repo-w-status')
  await git(repo, 'worktree', 'add', '-q', '-b', 'wt/w-status', worktree, 'main')
  await mkdir(join(tmp, 'workers'), { recursive: true })
  for (const [address, name] of [['t97', 'w-status'], ['t96', 'w-idle']]) {
    await writeFile(join(tmp, 'workers', `${address}.json`), JSON.stringify({ state: 'live', name, cwd: worktree, labels: {} }))
  }
  const id = await newTask('T-HELD')
  await note(id, block('nawaban-dispatch@2', { worker: 'w-status', terminal: 't97', accept: 'a', orchestrator: 'to1', agent: 'claude', model: 'opus' }))
  const ls = `,{"address":"t97","state":"live","cwd":"${worktree}"},{"address":"t96","state":"live","cwd":"${worktree}"}`
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('status', ['--project', 'nawaban'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls })
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('## 活着的 worker 2\n- t97 w-status T-HELD\n- t96 w-idle\n')
  expect(r.stdout).not.toMatch(/^- to1/m)
})

it('prints no worker section in status when no worker lives in this repository', async () => {
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('status', ['--project', 'nawaban'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(0)
  expect(r.stdout).not.toContain('活着的 worker')
})


it('records the checks on the ticket for merge to run, and puts them in the brief', async () => {
  const id = await newTask('D-CHK')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-CHK', '--brief', 'b', '--accept', 'a', '--check', 'pnpm test', '--check', "grep -q 'x' f"], { HC_ORCH: 'to1' })
  expect([r.code, r.stderr]).toEqual([0, ''])
  expect(r.hc).toContain("  grep -q 'x' f")
  expect((await replies(id)).map((m) => m.text)).toContain('验收检查：["pnpm test","grep -q \'x\' f"]')
})

it('refuses --check without a ticket to record it on, and starts nothing', async () => {
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'chk-none', '--brief', 'b', '--accept', 'a', '--check', 'true'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(2)
  expect(r.hc).not.toMatch(/^run/m)
})


async function worktreeChanging(name: string, file: string, committed = true) {
  const worktree = join(tmp, `held-${name}`)
  await git(repo, 'worktree', 'add', '-q', '-b', `held/${name}`, worktree, 'origin/main')
  await mkdir(join(worktree, file, '..'), { recursive: true })
  await writeFile(join(worktree, file), 'changed')
  if (committed) {
    await git(worktree, 'add', '.')
    await git(worktree, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'change')
  }
  return worktree
}

it.each([
  { brief: '改 board/src/dispatch.ts 和 nawaban/cli.py 的路由', paths: ['board/src/dispatch.ts', 'nawaban/cli.py'] },
  { brief: '只动 skills/land/ 下的文档，顺带 GLOSSARY.md', paths: ['skills/land', 'GLOSSARY.md'] },
  { brief: '只改 board/ 下的 CLI，别碰 hooks/', paths: ['board', 'hooks'] },
  { brief: '同线（scripts/gen-diagram.ts、docs/diagrams/hybrid-search*）', paths: ['scripts/gen-diagram.ts', 'docs/diagrams/hybrid-search*'] },
  { brief: '小票：查一下为什么慢', paths: [] },
])('reads the paths a brief names: $paths', ({ brief, paths }) => {
  expect(pathsIn(brief)).toEqual(paths)
})

it('routes a ticket with no lane to the running worker whose changes the brief names, and opens a new one when none overlap', async () => {
  const worktree = await worktreeChanging('ov-a', 'board/src/dispatch.ts')
  const hc = await fileTheLaneWorkerAt(worktree, 'other', 10_000)
  const id = await newTask('OV-B')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['OV-B', '--brief', '改 src/dispatch.ts 的路由', '--accept', 'a'], hc)
  expect(r.stderr).toBe('')
  expect(r.stdout).toBe('✓ OV-B 指派给在跑的 hc t99（改动文件重叠：board/src/dispatch.ts），它做完手上那张自己领 · 回报给 to1\n')
  expect(r.hc).not.toMatch(/^run/m)
  expect((await team.thread(id)).message.task?.for).toMatch(/\+cc-bbbb2222$/)
  await newTask('OV-C')
  const apart = await dispatchInTheRepositoryAsWindowAaaa1111(['OV-C', '--brief', '改 web/src/api.ts', '--accept', 'a'], hc)
  expect(apart.stdout).toMatch(/^✓ 派出 OV-C → hc t99 /)
  expect(apart.hc).toMatch(/^run --bg/m)
})

it('does not queue behind a worker on a directory-only brief, and says to name files', async () => {
  const worktree = await worktreeChanging('ov-dir', 'scripts/other.ts')
  const hc = await fileTheLaneWorkerAt(worktree, 'other', 10_000)
  await newTask('OV-D')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['OV-D', '--brief', '整理 scripts/ 下的脚本', '--accept', 'a'], hc)
  expect(r.stdout).toMatch(/^✓ 派出 OV-D → hc t99 /)
  expect(r.stdout).toContain('路径只写到目录，写到具体文件才能判重叠')
  expect(r.hc).toMatch(/^run --bg/m)
  const routed = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '整理 scripts/', '--json'], hc)
  expect(JSON.parse(routed.stdout)).toMatchObject({ terminal: null, by: null, hint: '路径只写到目录，写到具体文件才能判重叠' })
})

it('reads an extensionless file as a file and a dotted directory as a directory', async () => {
  const worktree = await worktreeChanging('ov-kind', 'hooks/Dockerfile')
  await mkdir(join(worktree, '.github', 'workflows'), { recursive: true })
  await writeFile(join(worktree, '.github', 'workflows', 'check.yml'), 'x')
  const hc = await fileTheLaneWorkerAt(worktree, 'other', 10_000)
  const file = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '改 hooks/Dockerfile', '--json'], hc)
  expect(JSON.parse(file.stdout)).toMatchObject({ terminal: 't99', by: '改动文件重叠：hooks/Dockerfile', hint: null })
  const directory = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '整理 .github/ 下的配置', '--json'], hc)
  expect(JSON.parse(directory.stdout)).toMatchObject({ terminal: null, hint: '路径只写到目录，写到具体文件才能判重叠' })
})

it('lists every file that overlaps when a brief names files', async () => {
  const worktree = await worktreeChanging('ov-files', 'scripts/a.ts')
  await writeFile(join(worktree, 'scripts', 'b.ts'), 'x')
  const hc = await fileTheLaneWorkerAt(worktree, 'other', 10_000)
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '改 scripts/a.ts 和 scripts/b.ts，scripts/ 下别的不动', '--json'], hc)
  expect(JSON.parse(r.stdout)).toMatchObject({ terminal: 't99', by: '改动文件重叠：scripts/a.ts、scripts/b.ts', hint: null })
})

it('counts uncommitted changes as the worker\'s own', async () => {
  const worktree = await worktreeChanging('ov-u', 'docs/notes.md', false)
  const hc = await fileTheLaneWorkerAt(worktree, 'other', 10_000)
  await newTask('OV-U')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['OV-U', '--brief', '补 docs/notes.md 一段', '--accept', 'a'], hc)
  expect(r.stdout).toContain('指派给在跑的 hc t99（改动文件重叠：docs/notes.md）')
})

it('leaves an overlapping worker that runs another model and opens a new one', async () => {
  const worktree = await worktreeChanging('ov-m', 'herdr/x.js')
  const hc = await fileTheLaneWorkerAt(worktree, 'other', 10_000, ['claude', '--model', 'sonnet'])
  await newTask('OV-M')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['OV-M', '--brief', '改 herdr/x.js', '--accept', 'a'], hc)
  expect(r.stdout).toContain('跳过了 t99 跑的是别的 agent 或模型')
})

it('tells which running worker the brief would go to, for the old CLI, without dispatching', async () => {
  const worktree = await worktreeChanging('ov-r', 'hooks/route.mjs')
  const hc = await fileTheLaneWorkerAt(worktree, 'other', 10_000)
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '改 hooks/route.mjs', '--json'], hc)
  expect(r.stderr).toBe('')
  expect(JSON.parse(r.stdout)).toMatchObject({ terminal: 't99', cwd: worktree, by: '改动文件重叠：hooks/route.mjs', warning: null, hint: null })
  expect(r.hc).not.toMatch(/^(run|send)/m)
  const none = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '查日志', '--json'], hc)
  expect(JSON.parse(none.stdout)).toMatchObject({ terminal: null, by: null })
})

it('warns, without refusing, once more than 8 workers live in this repository', async () => {
  const worktree = await worktreeChanging('crowd-wt', 'a.txt')
  const ls = (n: number) => Array.from({ length: n }, (_, i) => `,{"address":"tc${i}","state":"live","cwd":"${worktree}"}`).join('')
  const nine = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'crowd9', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls(9) })
  expect(nine.code).toBe(0)
  expect(nine.stdout).toContain('本仓库已有 9 个活着的 worker，超过 8 个')
  const eight = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'crowd8', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls(8) })
  expect(eight.stdout).not.toContain('活着的 worker')
})


const BRIEF_OF_ROUBAO_1973 = "派发判断：#1957 的后续，同线（scripts/gen-diagram.ts、docs/diagrams/hybrid-search*），t1pp 刚交完 → 指派给它。\n\n## 背景\n#1957 试点结论「改进后再试」（PR #1971 已合）：生成版锚点 0 漂移、参数表更全；手写版 648 句里锚点指错 117、行为不符 25。盲评生成版 12/15、手写版 14/15，丢分都在「条件在哪算」。\n\n## 要做的（改动范围：scripts/gen-diagram.ts、scripts/gen-diagram.config.ts、scripts/gen-diagram.test.ts、docs/diagrams/hybrid-search.generated.md）\n1. 生成器加三样：opt 条件里的变量回溯到赋值行；泳道分组、阶段标签、返回箭头（配置里声明）；每个节点加「守着它的测试」一列（从 *.test.ts 的 import / 调用关系出）。\n2. 手写版 S 步骤里的语句级规则：已有测试的列出测试名对照表；没有测试的列清单（补测试另开票，不在本票做）。\n3. 换一批更难的「改 X 要动哪里」题重测盲评，每版 ≥5 次，评测模型和写生成器的不同，答案键在看生成版之前从代码定。\n4. 结论：生成版不比手写版差，就提议把 hybrid-search.md 的「怎么做」换成生成版、手写只留指向 ADR「为什么」的链接（替换本身另开 PR，先报结论）。\n「生成物过期就红」挂进检查属于改闸，归吴献忠，本票只给方案不挂。"

async function fileWorker(address: string, cwd: string, statusMs: number) {
  await mkdir(join(tmp, 'workers'), { recursive: true })
  await writeFile(
    join(tmp, 'workers', `${address}.json`),
    JSON.stringify({
      state: 'live',
      name: address,
      cwd,
      argv: ['env', `BOARD_URL=${url}`, 'claude', '--model', 'opus', '/pstack:poteto-mode 任务：x'],
      labels: { 'revive.agent': 'claude', 'revive.session': `${address}-0000-session` },
      status: { app: 'claude-code', state: 'done' },
      status_ms: statusMs,
    }),
  )
  return `,{"address":"${address}","state":"live","cwd":"${cwd}","status_ms":${statusMs}}`
}

async function mergedPullRequestFrom(branch: string, files: string[]) {
  await mkdir(join(tmp, 'merged'), { recursive: true })
  await writeFile(join(tmp, 'merged', branch.replaceAll('/', '_')), files.join('\n') + '\n')
}

it('routes roubao #1973 to the worker that just merged the generator, not to the one editing a diagram it names', async () => {
  const editingTheDiagram = await worktreeChanging('w-1942', 'docs/diagrams/hybrid-search.md')
  const gone = join(tmp, 'repo-w-1957')
  await mergedPullRequestFrom('wt/w-1957', ['scripts/gen-diagram.ts', 'scripts/gen-diagram.test.ts', 'docs/diagrams/hybrid-search.generated.md'])
  const ls = (await fileWorker('t1p8', editingTheDiagram, 2_000)) + (await fileWorker('t1pp', gone, 1_000))
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', BRIEF_OF_ROUBAO_1973, '--json'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls })
  expect(r.stderr).toBe('')
  expect(JSON.parse(r.stdout)).toMatchObject({ terminal: 't1pp', cwd: gone, by: expect.stringMatching(/^改动文件重叠：.*scripts\/gen-diagram\.ts/) })
  expect(r.hc).toContain('gh pr list --head wt/w-1957 --state merged')
})

it('reads a worker whose branch is merged and empty by the pull request it merged last', async () => {
  const worktree = join(tmp, 'held-ra-next')
  await git(repo, 'worktree', 'add', '-q', '-b', 'wt/ra-done', worktree, 'origin/main')
  await git(worktree, 'switch', '-q', '-c', 'wt/ra-next', 'origin/main')
  await mergedPullRequestFrom('wt/ra-done', ['web/src/pages/TaskPage.tsx'])
  const ls = await fileWorker('t1ra', worktree, 1_000)
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '改 web/src/pages/TaskPage.tsx', '--json'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls })
  expect(JSON.parse(r.stdout)).toMatchObject({ terminal: 't1ra', by: '改动文件重叠：web/src/pages/TaskPage.tsx' })
})

it('picks the worker touching the most named files, and the latest active one on a tie', async () => {
  const one = await worktreeChanging('ra-one', 'hooks/inbox.sh')
  const two = join(tmp, 'held-ra-two')
  await git(repo, 'worktree', 'add', '-q', '-b', 'held/ra-two', two, 'origin/main')
  await mkdir(join(two, 'hooks'), { recursive: true })
  for (const f of ['hooks/inbox.sh', 'hooks/progress.sh']) await writeFile(join(two, f), 'x')
  const brief = '改 hooks/inbox.sh 和 hooks/progress.sh'
  const most = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', brief, '--json'], { HC_ORCH: 'to1', HC_LS_WORKERS: (await fileWorker('t1r1', one, 9_000)) + (await fileWorker('t1r2', two, 1_000)) })
  expect(JSON.parse(most.stdout).terminal).toBe('t1r2')
  const tie = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '改 hooks/inbox.sh', '--json'], { HC_ORCH: 'to1', HC_LS_WORKERS: (await fileWorker('t1r1', one, 9_000)) + (await fileWorker('t1r2', two, 1_000)) })
  expect(JSON.parse(tie.stdout).terminal).toBe('t1r1')
})


it('opens a new worker on the board when the routed worker\'s worktree is gone, and says so', async () => {
  const gone = join(tmp, 'repo-w-gone')
  await mergedPullRequestFrom('wt/w-gone', ['scripts/gen-gone.ts'])
  const ls = await fileWorker('t1gn', gone, 1_000)
  await newTask('RA-GONE')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['RA-GONE', '--brief', '改 scripts/gen-gone.ts', '--accept', 'a'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls })
  expect(r.stderr).toBe('')
  expect(r.stdout).toContain('跳过了 t1gn 的 worktree 已删')
  expect(r.hc).toMatch(/^run --bg/m)
})

it('counts a file changed both in a commit and in the working tree once', async () => {
  const once = join(tmp, 'held-ra-once')
  await git(repo, 'worktree', 'add', '-q', '-b', 'held/ra-once', once, 'origin/main')
  await mkdir(join(once, 'lib'), { recursive: true })
  await writeFile(join(once, 'lib/a.ts'), 'x')
  await git(once, 'add', '.')
  await git(once, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a')
  await writeFile(join(once, 'lib/a.ts'), 'y')
  const both = join(tmp, 'held-ra-both')
  await git(repo, 'worktree', 'add', '-q', '-b', 'held/ra-both', both, 'origin/main')
  await mkdir(join(both, 'lib'), { recursive: true })
  for (const f of ['lib/a.ts', 'lib/b.ts']) await writeFile(join(both, f), 'x')
  const ls = (await fileWorker('t1on', once, 9_000)) + (await fileWorker('t1bo', both, 1_000))
  const r = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '改 lib/a.ts 和 lib/b.ts', '--json'], { HC_ORCH: 'to1', HC_LS_WORKERS: ls })
  expect(JSON.parse(r.stdout).terminal).toBe('t1bo')
})



it('looks up a merged pull request as the repository\'s GitHub account', async () => {
  const gone = join(tmp, 'repo-w-acct')
  await mergedPullRequestFrom('wt/w-acct', ['scripts/acct.ts'])
  await mkdir(join(repo, 'docs', 'agents'), { recursive: true })
  await writeFile(join(repo, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n\ngithub-account: owner-acct\n')
  try {
    const r = await nawabanInTheRepositoryAsWindowAaaa1111('route', ['--brief', '改 scripts/acct.ts', '--json'], { HC_ORCH: 'to1', HC_LS_WORKERS: await fileWorker('t1ac', gone, 1_000) })
    expect(JSON.parse(r.stdout).terminal).toBe('t1ac')
    expect(r.hc).toMatch(/^gh pr list --head wt\/w-acct .* token=tok-owner-acct$/m)
  } finally {
    await rm(join(repo, 'docs'), { recursive: true, force: true })
  }
})

