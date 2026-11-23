import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
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

const HC_STAND_IN_LOGGING_CALLS_KNOWING_ONE_ORCHESTRATOR_STARTING_T99 = `#!/bin/sh
printf '%s\\n' "$*" >> "$HC_LOG"
case "$1" in
  get) if [ -n "$HC_ORCH" ] && [ "$2" = "$HC_ORCH" ]; then echo '{"labels":{"role":"orchestrator"}}'; else echo '{"labels":{}}'; fi ;;
  ls) if [ -n "$HC_ORCH" ]; then echo "{\\"terminals\\":[{\\"address\\":\\"$HC_ORCH\\",\\"state\\":\\"live\\",\\"cwd\\":\\"$HC_ORCH_CWD\\"}]}"; else echo '{"terminals":[]}'; fi ;;
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
  await writeFile(join(tmp, 'hc'), HC_STAND_IN_LOGGING_CALLS_KNOWING_ONE_ORCHESTRATOR_STARTING_T99)
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

it('refuses an agent it has no row for, and starts nothing', async () => {
  const r = await dispatchInTheRepositoryAsWindowAaaa1111(['--name', 'row-gemini', '--agent', 'gemini', '--brief', 'b', '--accept', 'a'], { HC_ORCH: 'to1' })
  expect(r.code).toBe(2)
  expect(r.stderr).toContain('--agent claude|codex|agy')
  expect(r.hc).toBe('')
  expect(existsSync(join(tmp, 'repo-row-gemini'))).toBe(false)
})
