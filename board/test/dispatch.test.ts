import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { workerTitle } from '../src/dispatch.ts'
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

const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args])

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'nawaban-dispatch-')))
  await writeFile(join(tmp, 'hc'), HC_STAND_IN_LOGGING_CALLS_KNOWING_ONE_ORCHESTRATOR_AND_ANY_WORKER_FILED_IN_HC_WORKERS_STARTING_T99)
  await chmod(join(tmp, 'hc'), 0o755)
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
  expect(run).not.toContain('cli.ts')
  expect(run).not.toContain('to1')
  expect((await git(join(tmp, 'repo-d-go'), 'branch', '--show-current')).stdout.trim()).toBe('wt/d-go')
  const [reply] = await replies(id)
  expect(reply?.author).toMatchObject({ kind: 'agent', handle: 'victor/cc-aaaa1111' })
  expect(reply?.blocks).toMatchObject([{ schema: 'nawaban-dispatch', data: { worker: 'd-go', terminal: 't99', accept: 'it is done', orchestrator: 'to1', agent: 'claude', model: 'opus' } }])
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

async function fileTheLaneWorkerAt(worktree: string, lane: string, contextTokens: number, startedAs = ['claude', '--model', 'opus']) {
  await mkdir(join(tmp, 'workers'), { recursive: true })
  await writeFile(
    join(tmp, 'workers', `${LANE_WORKER}.json`),
    JSON.stringify({
      state: 'live',
      name: 'first-of-lane',
      cwd: worktree,
      argv: ['env', `BOARD_URL=${url}`, ...startedAs, '/pstack:poteto-mode 任务：A'],
      labels: { lane, 'revive.agent': 'claude', 'revive.session': WORKER_SESSION },
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
  const made = async (key: string, ...more: string[]) => JSON.parse((await cliAsWindowOf('orch0000-0000', ['create', key, '--title', key, '--project', 'nawaban', '--json', ...more])).stdout).task.id as string
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
  expect(status.stdout).toContain('进展 0 分钟前：回报未送达：完成 PR #9')
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
