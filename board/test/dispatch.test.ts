import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { registerSchemas } from '../src/schemas.ts'
import { listen, verifier } from '../src/server.ts'

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

async function dispatchInTheRepositoryAsWindowAaaa1111(argv: string[], hc: Record<string, string>) {
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
    HC_WORKERS: join(tmp, 'workers'),
    HC_LS_WORKERS: '',
    CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
    CODEX_HOME: '',
    ...hc,
  }
  for (const thisMachinesBoardSetting of ['NAWABAN_BOARD_DIR', 'NAWABAN_BOARD_PORT']) delete env[thisMachinesBoardSetting]
  const r = await exec('node', [CLI, 'dispatch', ...argv], { cwd: repo, env }).then(
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
  expect(r.stderr).toContain('no live orchestrator')
  expect(r.hc).not.toMatch(/^run/m)
  expect(existsSync(join(tmp, 'repo-d-none'))).toBe(false)
  expect(await replies(id)).toEqual([])
})

it('starts the worker in its own worktree, briefed to report to the orchestrator, and records it as this window', async () => {
  const id = await newTask('D-GO')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-GO', '--brief', 'do it', '--accept', 'it is done'], { HC_ORCH: 'to1' })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  const run = r.hc.slice(r.hc.indexOf('run --bg'))
  expect(run).toContain(`--name d-go --cwd ${join(tmp, 'repo-d-go')} env BOARD_URL=${url} claude --model opus`)
  expect(run).toContain('hc send to1 "回报：D-GO 完成')
  expect((await git(join(tmp, 'repo-d-go'), 'branch', '--show-current')).stdout.trim()).toBe('wt/d-go')
  const [reply] = await replies(id)
  expect(reply?.author).toMatchObject({ kind: 'agent', handle: 'victor/cc-aaaa1111' })
  expect(reply?.blocks).toMatchObject([{ schema: 'nawaban-dispatch', data: { worker: 'd-go', terminal: 't99', accept: 'it is done' } }])
})

it('removes the worktree and records nothing when hc run fails', async () => {
  const id = await newTask('D-FAIL')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-FAIL', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1', HC_RUN_FAIL: '1' })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('hc run failed, worktree removed')
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
  { agent: [], model: [], starts: 'claude --model opus /pstack:poteto-mode 任务：row-default\n' },
  { agent: ['--agent', 'claude'], model: ['--model', 'sonnet'], starts: 'claude --model sonnet /pstack:poteto-mode 任务：row-claude\n' },
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

it('hands the next task of a lane to the worker running it, on a new branch it cuts once done, claimed for it once ready', async () => {
  const { first, second, worktree } = await laneOfTwoWhereFirstBlocksSecond('LN', 'board')
  await (await team.as('cc-bbbb2222').tasks.claim(first, { lease: 3600 })).complete()
  const hc = await fileTheLaneWorkerAt(worktree, 'board', 300_000)
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LN-B', '--brief', 'second', '--accept', 'b done'], hc)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.stdout).toContain('handed LN-B to running hc t99 (lane board)')
  expect(r.stdout).toContain('claimed for it')
  expect(r.hc).not.toMatch(/^run/m)
  expect(r.hc).toMatch(/^send t99 \/pstack:poteto-mode 任务：LN-B/m)
  expect(r.hc).toContain(`接着用 ${worktree}`)
  expect(r.hc).toContain('git fetch origin main && git switch -c wt/ln-b origin/main')
  expect(r.hc).toContain('hc send to1 "回报：LN-B 完成')
  expect(existsSync(join(tmp, 'repo-ln-b'))).toBe(false)
  const b = (await team.thread(second)).message
  expect(b.task?.claim?.actor).toMatch(/\+cc-bbbb2222$/)
  expect(b.labels.terminal).toBe('t99')
  expect((await replies(second)).at(-1)?.blocks).toMatchObject([{ schema: 'nawaban-dispatch', data: { worker: 'first-of-lane', terminal: 't99', accept: 'b done' } }])
})

it('hands a task still blocked in its lane to the same worker and leaves the claim to it', async () => {
  const { second, worktree } = await laneOfTwoWhereFirstBlocksSecond('LQ', 'queue')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['LQ-B', '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(worktree, 'queue', 10_000))
  expect(r.stderr).toBe('')
  expect(r.stdout).toContain('handed LQ-B to running hc t99 (lane queue)')
  expect(r.stdout).toContain('it claims when it starts')
  expect((await team.thread(second)).message.task?.claim ?? null).toBeNull()
  expect((await replies(second)).at(-1)?.blocks).toMatchObject([{ schema: 'nawaban-dispatch', data: { terminal: 't99' } }])
})

it.each([
  { why: 'its worker has used half its context', lane: 'half', secondLane: 'half', tokens: 500_000, argv: [], passedOver: 't99 has used 50% of its context' },
  { why: 'it is in another lane', lane: 'one', secondLane: 'other', tokens: 10_000, argv: [], passedOver: undefined },
  { why: 'it asks for another model', lane: 'model', secondLane: 'model', tokens: 10_000, argv: ['--model', 'sonnet'], passedOver: 't99 runs another agent or model' },
  { why: 'it asks for Codex on its default model and the worker runs another', lane: 'cxm', secondLane: 'cxm', tokens: 10_000, argv: ['--agent', 'codex'], startedAs: ['codex', '-m', 'other'], passedOver: 't99 runs another agent or model' },
  { why: '--new asks for parallel work', lane: 'par', secondLane: 'par', tokens: 10_000, argv: ['--new'], passedOver: undefined },
])('starts a new worker when $why', async ({ lane, secondLane, tokens, argv, passedOver, startedAs }) => {
  const prefix = `LF${lane.toUpperCase()}`
  const { worktree } = await laneOfTwoWhereFirstBlocksSecond(prefix, lane, secondLane)
  const r = await dispatchInTheRepositoryAsWindowAaaa1111([`${prefix}-B`, ...argv, '--brief', 'second', '--accept', 'b'], await fileTheLaneWorkerAt(worktree, lane, tokens, startedAs))
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.hc).toMatch(/^run --bg/m)
  expect(r.hc).not.toMatch(/^send/m)
  expect(r.stdout).toContain(`dispatched ${prefix}-B → hc t99 (lane ${secondLane})`)
  if (passedOver) expect(r.stdout).toContain(passedOver)
  expect(existsSync(join(tmp, `repo-${prefix.toLowerCase()}-b`))).toBe(true)
})

it('refuses --to a terminal outside this repository, and starts nothing', async () => {
  await newTask('D-TO')
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['D-TO', '--to', 'tnowhere', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('--to tnowhere is no live terminal in this repository')
  expect(r.hc).not.toMatch(/^(run|send)/m)
})
