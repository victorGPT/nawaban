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
import { registerSchemas } from '../src/schemas.ts'
import { listen, verifier } from '../src/server.ts'

const exec = promisify(execFile)
const CLI = join(import.meta.dirname, '../src/cli.ts')
const SECRET = 'test-secret'
let HEAD = ''
const ORCH = 'to1'
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let url = ''
let tmp = ''
let repo = ''

const HC_STAND_IN_LOGGING_CALLS_KNOWING_ONE_ORCHESTRATOR_AND_ANY_WORKER_FILED_IN_HC_WORKERS = `#!/bin/sh
printf '%s\\n' "$*" >> "$HC_LOG"
case "$1" in
  get) if [ "$2" = "$HC_ORCH" ]; then echo '{"labels":{"role":"orchestrator"}}'; elif [ -f "$HC_WORKERS/$2.json" ]; then cat "$HC_WORKERS/$2.json"; else echo '{"labels":{}}'; fi ;;
  ls) echo "{\\"terminals\\":[{\\"address\\":\\"$HC_ORCH\\",\\"state\\":\\"live\\",\\"cwd\\":\\"$HC_ORCH_CWD\\"}]}" ;;
  kill) if [ -n "$HC_KILL_FAIL" ]; then echo 'no such terminal' >&2; exit 1; fi ;;
esac
`

const GH_STAND_IN_ANSWERING_PR_VIEW_FROM_GH_PR_AND_LOGGING_MERGES = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr view") cat "$GH_PR" ;;
  "run list") if [ -n "$GH_RUNS" ]; then printf '%s' "$GH_RUNS"; else echo '[]'; fi ;;
esac
`

const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

async function upstreamCommit(message: string, touching?: string) {
  const other = join(tmp, `other-${Math.random()}`)
  await exec('git', ['clone', '-q', join(tmp, 'origin.git'), other])
  if (touching) {
    await mkdir(join(other, touching, '..'), { recursive: true })
    await writeFile(join(other, touching), message)
    await git(other, 'add', '-A')
  }
  await git(other, 'commit', '-q', '--allow-empty', '-m', message)
  await git(other, 'push', '-q', 'origin', 'HEAD:main')
}

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'nawaban-merge-')))
  for (const [name, script] of [['hc', HC_STAND_IN_LOGGING_CALLS_KNOWING_ONE_ORCHESTRATOR_AND_ANY_WORKER_FILED_IN_HC_WORKERS], ['gh', GH_STAND_IN_ANSWERING_PR_VIEW_FROM_GH_PR_AND_LOGGING_MERGES]] as const) {
    await writeFile(join(tmp, name), script)
    await chmod(join(tmp, name), 0o755)
  }
  await mkdir(join(tmp, 'workers'))
  await mkdir(join(tmp, 'board'))
  await exec('git', ['init', '-q', '--bare', '-b', 'main', join(tmp, 'origin.git')])
  repo = join(tmp, 'repo')
  await exec('git', ['clone', '-q', join(tmp, 'origin.git'), repo])
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  await git(repo, 'push', '-q', '-u', 'origin', 'HEAD:main')
  HEAD = (await git(repo, 'rev-parse', 'HEAD')).stdout.trim()
})
afterAll(() => server.close())

type Pr = Record<string, unknown>
const greenCodePr = (key: string): Pr => ({
  number: 5,
  state: 'OPEN',
  url: `https://github.com/o/r/pull/${key}`,
  title: key,
  headRefName: `wt/${key.toLowerCase()}`,
  headRefOid: HEAD,
  files: [{ path: 'board/src/merge.ts' }],
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'ci/x', state: 'SUCCESS' }],
  comments: [{ body: `看过了\nCodex review：无挡合并（${HEAD.slice(0, 7)}）` }],
  mergeCommit: null,
})

const note = (id: string, text: string) => team.as('cc-orch0000').reply(id, text)
const replies = async (id: string) => (await team.thread(id)).replies
const newTask = async (key: string) => (await team.as(null).tasks.create('nawaban', { id: key, text: key, labels: { key } })).task.id
const dispatchedTo = (id: string, terminal: string) => note(id, block('nawaban-dispatch@1', { worker: 'w', terminal, accept: 'a' }))

const boardCliAsSession = (session: string, cwd: string, ...argv: string[]) =>
  exec('node', [CLI, ...argv], { cwd, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, CLAUDE_CODE_SESSION_ID: session, HC_TERMINAL_ID: '' } })

async function workerOnItsOwnTicket(key: string, terminal: string, pr: Pr = greenCodePr(key)) {
  const id = await newTask(key)
  const worktree = join(tmp, `repo-${key.toLowerCase()}`)
  await git(repo, 'worktree', 'add', '-q', '-b', `wt/${key.toLowerCase()}`, worktree, 'main')
  await writeFile(join(tmp, 'workers', `${terminal}.json`), JSON.stringify({ state: 'live', name: key.toLowerCase(), cwd: worktree, labels: {} }))
  await dispatchedTo(id, terminal)
  await boardCliAsSession('aaaa1111-0000', worktree, 'claim', key)
  await writeFile(join(tmp, `pr-${key}.json`), JSON.stringify(pr))
  return { id, worktree }
}

async function mergeAsTheWorker(key: string, terminal: string, worktree: string, extra: Record<string, string> = {}) {
  const hcLog = join(tmp, `hc-${key}.log`)
  const ghLog = join(tmp, `gh-${key}.log`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${tmp}:${process.env.PATH}`,
    BOARD_URL: url,
    BOARD_TOKEN: SECRET,
    XDG_CONFIG_HOME: tmp,
    NAWABAN_BOARD_DIR: join(tmp, 'board'),
    NAWABAN_PLUGIN_DIR: join(tmp, 'no-plugin'),
    HERDR_MODS_DIR: join(tmp, 'no-herdr'),
    CLAUDE_CODE_SESSION_ID: 'aaaa1111-0000',
    HC_TERMINAL_ID: terminal,
    HC_LOG: hcLog,
    HC_ORCH: ORCH,
    HC_ORCH_CWD: repo,
    HC_WORKERS: join(tmp, 'workers'),
    GH_PR: join(tmp, `pr-${key}.json`),
    GH_LOG: ghLog,
    ...extra,
  }
  delete env.NAWABAN_BOARD_PORT
  const r = await exec('node', [CLI, 'merge', '5'], { cwd: worktree, env }).then(
    (ok) => ({ code: 0, ...ok }),
    (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }),
  )
  const read = async (f: string) => (existsSync(f) ? await readFile(f, 'utf8') : '')
  return { ...r, hc: await read(hcLog), gh: await read(ghLog) }
}

const lastNote = async (id: string) => (await replies(id)).at(-1)?.text ?? ''
const stateOf = async (id: string) => (await team.thread(id)).message.task?.state

it('waits on a check still running: exit 3, no merge, no one told', async () => {
  const pr = { ...greenCodePr('M-WAIT'), statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' }] }
  const { id, worktree } = await workerOnItsOwnTicket('M-WAIT', 't70', pr)
  const r = await mergeAsTheWorker('M-WAIT', 't70', worktree)
  expect(r.code).toBe(3)
  expect(r.stdout).toContain('CI 还在跑：test')
  expect(r.gh).not.toMatch(/^pr merge/m)
  expect(r.hc).not.toMatch(/^send/m)
  expect(await stateOf(id)).not.toBe('completed')
})

it('waits while CI has no checks yet', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-EMPTY', 't69', { ...greenCodePr('M-EMPTY'), statusCheckRollup: [] })
  expect((await mergeAsTheWorker('M-EMPTY', 't69', worktree)).code).toBe(3)
})

it('waits while the only checks were skipped, so a workflow not yet registered never reads as green', async () => {
  const pr = { ...greenCodePr('M-SKIP'), statusCheckRollup: [{ __typename: 'CheckRun', name: 'external', status: 'COMPLETED', conclusion: 'SKIPPED' }] }
  const { worktree } = await workerOnItsOwnTicket('M-SKIP', 't68', pr)
  const r = await mergeAsTheWorker('M-SKIP', 't68', worktree)
  expect(r.code).toBe(3)
  expect(r.gh).not.toMatch(/^pr merge/m)
})

it('waits while the head carries workflows that have not run on it yet, however green its other checks', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-NORUN', 't67')
  await mkdir(join(worktree, '.github', 'workflows'), { recursive: true })
  await writeFile(join(worktree, '.github', 'workflows', 'ci.yml'), 'on: pull_request\n')
  await git(worktree, 'add', '-A')
  await git(worktree, 'commit', '-q', '-m', 'ci')
  const head = (await git(worktree, 'rev-parse', 'HEAD')).stdout.trim()
  const pr = { ...greenCodePr('M-NORUN'), headRefOid: head, comments: [{ body: `Codex review：无挡合并 ${head.slice(0, 7)}` }] }
  await writeFile(join(tmp, 'pr-M-NORUN.json'), JSON.stringify(pr))
  const none = await mergeAsTheWorker('M-NORUN', 't67', worktree)
  expect(none.code).toBe(3)
  expect(none.gh).not.toMatch(/^pr merge/m)
  const running = await mergeAsTheWorker('M-NORUN', 't67', worktree, { GH_RUNS: JSON.stringify([{ name: 'ci', status: 'in_progress', conclusion: '' }]) })
  expect(running.code).toBe(3)
  expect(running.stdout).toContain('CI 还在跑：ci')
})

it('refuses a ticket the merging session does not hold, before anything changes', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-THEIRS', 't66')
  await boardCliAsSession('aaaa1111-0000', worktree, 'claim', 'M-THEIRS', '--release')
  await boardCliAsSession('other000-0000', worktree, 'claim', 'M-THEIRS')
  expect(id).toBeTruthy()
  const r = await mergeAsTheWorker('M-THEIRS', 't66', worktree)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('不在 cc-aaaa1111 手里')
  expect(r.gh).not.toMatch(/^pr merge/m)
})

it('refuses a review whose verdict line names another head, even when the comment names this one elsewhere', async () => {
  const pr = greenCodePr('M-SPLIT')
  const { worktree } = await workerOnItsOwnTicket('M-SPLIT', 't65', { ...pr, comments: [{ body: `Codex review：无挡 0000000\n新 head ${pr.headRefOid} 还没 review` }] })
  const r = await mergeAsTheWorker('M-SPLIT', 't65', worktree)
  expect(r.code).toBe(1)
  expect(r.gh).not.toMatch(/^pr merge/m)
})

it('refuses a failed check: exit 1, no merge, one line to the orchestrator, a note on the ticket', async () => {
  const pr = { ...greenCodePr('M-RED'), statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }
  const { id, worktree } = await workerOnItsOwnTicket('M-RED', 't71', pr)
  const r = await mergeAsTheWorker('M-RED', 't71', worktree)
  expect(r.code).toBe(1)
  expect(r.gh).not.toMatch(/^pr merge/m)
  expect(r.hc.match(/^send .*$/gm)).toEqual([`send ${ORCH} M-RED PR #5 merge: 拒合 — CI 没过：test`])
  expect(await lastNote(id)).toBe('merge: 拒合 — CI 没过：test')
})

it.each([
  { why: 'no review comment', comments: [] as { body: string }[] },
  { why: 'a review of an older head', comments: [{ body: 'Codex review：无挡合并 1234567' }] },
  { why: 'a sha with no verdict line', comments: [{ body: `有挡 ${HEAD}` }] },
])('refuses a code PR with $why', async ({ why, comments }) => {
  const key = `M-RV${why.length}`
  const { id, worktree } = await workerOnItsOwnTicket(key, `t72${why.length}`, { ...greenCodePr(key), comments })
  const r = await mergeAsTheWorker(key, `t72${why.length}`, worktree)
  expect(r.code).toBe(1)
  expect(r.gh).not.toMatch(/^pr merge/m)
  expect(await lastNote(id)).toContain(`merge: 拒合 — 没有对 head ${HEAD.slice(0, 7)} 的 review 无挡结论`)
})

it('merges a docs-only PR with no review', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-DOCS', 't73', { ...greenCodePr('M-DOCS'), comments: [], files: [{ path: 'docs/a.md' }, { path: 'README.md' }] })
  const r = await mergeAsTheWorker('M-DOCS', 't73', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.gh).toContain(`pr merge 5 --squash --match-head-commit ${HEAD}`)
  expect(await stateOf(id)).toBe('completed')
})

it('merges a green reviewed PR, pulls the main checkout, closes the ticket with its link, and retires the worker last', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-GO', 't74')
  await upstreamCommit('landed M-GO')
  const r = await mergeAsTheWorker('M-GO', 't74', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.gh).toContain(`pr merge 5 --squash --match-head-commit ${HEAD}`)
  expect(r.gh).not.toContain('--delete-branch')
  expect((await git(repo, 'log', '-1', '--format=%s')).stdout.trim()).toBe('landed M-GO')
  expect(await stateOf(id)).toBe('completed')
  const all = await replies(id)
  expect(all.some((x) => x.blocks.some((b) => b.schema === 'nawaban-link' && (b.data as { ref: string }).ref === 'https://github.com/o/r/pull/M-GO'))).toBe(true)
  expect(all.at(-1)?.text).toMatch(/^merge: 已合 PR #5，.*收 worker t74/)
  expect(existsSync(worktree)).toBe(false)
  expect(r.hc.trim().split('\n').at(-1)).toBe('kill t74')
  expect(r.hc).not.toMatch(/^send/m)
})

it('retires the worker on a rerun even when its lane gained a next ticket after its worktree was removed', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-GONE', 't77')
  await note(id, 'lane: gone-lane')
  const first = await mergeAsTheWorker('M-GONE', 't77', worktree, { HC_KILL_FAIL: '1' })
  expect(first.code).toBe(1)
  expect(existsSync(worktree)).toBe(false)
  const next = await newTask('M-GONE-NEXT')
  await note(next, 'lane: gone-lane')
  await writeFile(join(tmp, 'pr-M-GONE.json'), JSON.stringify({ ...greenCodePr('M-GONE'), state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } }))
  const rerun = await mergeAsTheWorker('M-GONE', 't77', repo)
  expect(rerun.code).toBe(0)
  expect(rerun.hc.trim().split('\n').at(-1)).toBe('kill t77')
})

it('refuses when the head is not readable locally, so its workflows can not be skipped unseen', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-UNSEEN', 't64', { ...greenCodePr('M-UNSEEN'), headRefOid: '1234567890abcdef1234567890abcdef12345678', comments: [{ body: 'Codex review：无挡 1234567890ab' }] })
  const r = await mergeAsTheWorker('M-UNSEEN', 't64', worktree)
  expect(r.code).toBe(1)
  expect(r.stdout).toContain('本地读不到 head')
  expect(r.gh).not.toMatch(/^pr merge/m)
})

it('counts a worker that has already exited as retired on a rerun, even with its worktree left and a next ticket in its lane', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-EXITED', 't78')
  await note(id, 'lane: exited-lane')
  await note(await newTask('M-EXITED-NEXT'), 'lane: exited-lane')
  await writeFile(join(tmp, 'workers', 't78.json'), JSON.stringify({ state: 'finished', cwd: worktree, labels: {} }))
  await writeFile(join(tmp, 'pr-M-EXITED.json'), JSON.stringify({ ...greenCodePr('M-EXITED'), state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } }))
  const rerun = await mergeAsTheWorker('M-EXITED', 't78', worktree)
  expect(rerun.code).toBe(0)
  expect(rerun.stdout).toContain('worker t78 已不在')
  expect(rerun.hc).not.toMatch(/^(kill|send)/m)
})

it('tells the orchestrator when the kill fails after the worktree is gone, and a rerun from the main checkout finishes the retirement', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-KILL', 't76')
  const first = await mergeAsTheWorker('M-KILL', 't76', worktree, { HC_KILL_FAIL: '1' })
  expect(first.code).toBe(1)
  expect(await stateOf(id)).toBe('completed')
  expect(existsSync(worktree)).toBe(false)
  expect(first.hc).toMatch(new RegExp(`^send ${ORCH} M-KILL PR #5 merge: 已合未收完 — hc kill t76 失败`, 'm'))
  await writeFile(join(tmp, 'pr-M-KILL.json'), JSON.stringify({ ...greenCodePr('M-KILL'), state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } }))
  const rerun = await mergeAsTheWorker('M-KILL', 't76', repo)
  expect(rerun.code).toBe(0)
  expect(rerun.gh.match(/^pr merge/gm)).toHaveLength(1)
  expect(rerun.hc.trim().split('\n').at(-1)).toBe('kill t76')
})

it('hands the next ready task of the lane to the worker instead of retiring it', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-LN', 't75')
  await note(id, 'lane: merge-lane')
  const next = await newTask('M-LN-NEXT')
  await note(next, 'lane: merge-lane')
  const r = await mergeAsTheWorker('M-LN', 't75', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await stateOf(id)).toBe('completed')
  expect(r.hc).not.toMatch(/^kill/m)
  expect(r.hc).toMatch(/^send t75 \/pstack:poteto-mode 任务：M-LN-NEXT/m)
  expect((await replies(next)).at(-1)?.blocks).toMatchObject([{ schema: 'nawaban-dispatch', data: { terminal: 't75' } }])
  expect(existsSync(worktree)).toBe(true)
})

it('leaves a worker alone that still has another open ticket', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-BUSY', 't76')
  await dispatchedTo(await newTask('M-BUSY-OTHER'), 't76')
  const r = await mergeAsTheWorker('M-BUSY', 't76', worktree)
  expect(r.code).toBe(0)
  expect(await stateOf(id)).toBe('completed')
  expect(r.hc).not.toMatch(/^(kill|send)/m)
  expect(existsSync(worktree)).toBe(true)
})

it('merges, but leaves the plugin unpulled and tells the orchestrator while what it would pull carries a schema change, whatever this PR touched', async () => {
  const plugin = join(tmp, 'plugin')
  await exec('git', ['clone', '-q', join(tmp, 'origin.git'), plugin])
  const before = (await git(plugin, 'rev-parse', 'HEAD')).stdout
  const { id, worktree } = await workerOnItsOwnTicket('M-SCHEMA', 't77')
  await upstreamCommit('unapproved schema change', 'board/src/schemas.ts')
  await upstreamCommit('landed M-SCHEMA')
  const r = await mergeAsTheWorker('M-SCHEMA', 't77', worktree, { NAWABAN_PLUGIN_DIR: plugin })
  expect(r.code).toBe(1)
  expect(r.gh).toMatch(/^pr merge/m)
  expect((await git(plugin, 'rev-parse', 'HEAD')).stdout).toBe(before)
  expect(r.hc).toMatch(new RegExp(`^send ${ORCH} M-SCHEMA PR #5 merge: 已合未收完 — 插件要拉进来的改动里有 schema，要决策者点头再 pull；pull 之后重跑 merge 收尾$`, 'm'))
  expect(await lastNote(id)).toBe('merge: 已合未收完 — 插件要拉进来的改动里有 schema，要决策者点头再 pull；pull 之后重跑 merge 收尾')
  expect(r.hc).not.toMatch(/^kill/m)
  await git(plugin, 'pull', '-q', '--ff-only')
  const landed = (await git(plugin, 'rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(tmp, 'pr-M-SCHEMA.json'), JSON.stringify({ ...greenCodePr('M-SCHEMA'), state: 'MERGED', mergeCommit: { oid: landed } }))
  const rerun = await mergeAsTheWorker('M-SCHEMA', 't77', worktree, { NAWABAN_PLUGIN_DIR: plugin })
  expect(rerun.code).toBe(0)
  expect(rerun.hc.trim().split('\n').at(-1)).toBe('kill t77')
})

it('holds a schema change when the main checkout is the plugin, never pulling it in first', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-SAME', 't63')
  const before = (await git(repo, 'rev-parse', 'HEAD')).stdout
  await upstreamCommit('unapproved schema change for the shared checkout', 'board/src/schemas.ts')
  const r = await mergeAsTheWorker('M-SAME', 't63', worktree, { NAWABAN_PLUGIN_DIR: repo })
  expect(r.code).toBe(1)
  expect((await git(repo, 'rev-parse', 'HEAD')).stdout).toBe(before)
  expect(r.stdout).toContain('插件要拉进来的改动里有 schema')
})

it('pulls the plugin when it tracks this repository and the PR touches no schema', async () => {
  const plugin = join(tmp, 'plugin-ok')
  await exec('git', ['clone', '-q', join(tmp, 'origin.git'), plugin])
  const { worktree } = await workerOnItsOwnTicket('M-PLUG', 't79')
  await upstreamCommit('landed M-PLUG')
  const r = await mergeAsTheWorker('M-PLUG', 't79', worktree, { NAWABAN_PLUGIN_DIR: plugin })
  expect(r.code).toBe(0)
  expect((await git(plugin, 'log', '-1', '--format=%s')).stdout.trim()).toBe('landed M-PLUG')
})

it('copies the pulled Herdr panel over the installed one, keeping the files Herdr put there', async () => {
  const plugin = join(tmp, 'plugin-mod')
  await exec('git', ['clone', '-q', join(tmp, 'origin.git'), plugin])
  const { worktree } = await workerOnItsOwnTicket('M-MOD', 't76')
  const other = join(tmp, 'other-mod')
  await exec('git', ['clone', '-q', join(tmp, 'origin.git'), other])
  await mkdir(join(other, 'herdr', 'mods', 'nawaban-board'), { recursive: true })
  await writeFile(join(other, 'herdr', 'install-mod.sh'), await readFile(join(import.meta.dirname, '../../herdr/install-mod.sh')))
  await writeFile(join(other, 'herdr', 'mods', 'nawaban-board', 'logic.js'), 'landed M-MOD')
  await git(other, 'add', '-A')
  await git(other, 'commit', '-q', '-m', 'landed M-MOD')
  await git(other, 'push', '-q', 'origin', 'HEAD:main')
  const mods = join(tmp, 'herdr-mods')
  await mkdir(join(mods, 'nawaban-board'), { recursive: true })
  await writeFile(join(mods, 'nawaban-board', 'logic.js'), 'old copy')
  await writeFile(join(mods, 'nawaban-board', 'jsconfig.json'), '{}')
  const r = await mergeAsTheWorker('M-MOD', 't76', worktree, { NAWABAN_PLUGIN_DIR: plugin, HERDR_MODS_DIR: mods })
  expect(r.code).toBe(0)
  expect(await readFile(join(mods, 'nawaban-board', 'logic.js'), 'utf8')).toBe('landed M-MOD')
  expect(await readFile(join(mods, 'nawaban-board', 'jsconfig.json'), 'utf8')).toBe('{}')
})

it('picks up after a merged PR on a rerun without merging again', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-AGAIN', 't78', { ...greenCodePr('M-AGAIN'), state: 'MERGED', mergeCommit: { oid: 'f00' }, statusCheckRollup: [] })
  const r = await mergeAsTheWorker('M-AGAIN', 't78', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.gh).not.toMatch(/^pr merge/m)
  expect(await stateOf(id)).toBe('completed')
})

it('refuses a branch that names no ticket', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-LOST', 't80', { ...greenCodePr('M-LOST'), headRefName: 'feature/x' })
  const r = await mergeAsTheWorker('M-LOST', 't80', worktree)
  expect(r.code).toBe(1)
  expect(r.gh).not.toMatch(/^pr merge/m)
  expect(r.hc).toMatch(/^send to1 .*拒合 — 分支 feature\/x 找不到票/m)
})
