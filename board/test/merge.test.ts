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
printf '%s\\n' "$GH_TOKEN" >> "$GH_LOG.tokens"
case "$1 $2" in
  "auth token") echo tok-declared ;;
  "pr view") cat "$GH_PR" ;;
  "run list") if [ -n "$GH_RUNS" ]; then printf '%s' "$GH_RUNS"; else echo '[]'; fi ;;
  "pr merge") if [ -s "$GH_MERGE_FAILS" ]; then head -n1 "$GH_MERGE_FAILS" >&2; sed -i.bak 1d "$GH_MERGE_FAILS"; exit 1; fi ;;
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
  await mkdir(join(repo, 'docs/agents'), { recursive: true })
  await writeFile(join(repo, 'docs/agents/issue-tracker.md'), 'github-account: victorGPT\n')
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
const newTask = async (key: string, channel = 'nawaban') => (await team.as(null).tasks.create(channel, { id: key, text: key, labels: { key } })).task.id
const dispatchedTo = (id: string, terminal: string) => note(id, block('nawaban-dispatch@1', { worker: 'w', terminal, accept: 'a' }))

const boardCliAsSession = (session: string, cwd: string, ...argv: string[]) => boardCliAsSessionIn('', session, cwd, ...argv)
const boardCliAsSessionIn = (terminal: string, session: string, cwd: string, ...argv: string[]) =>
  exec('node', [CLI, ...argv], { cwd, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, CLAUDE_CODE_SESSION_ID: session, HC_TERMINAL_ID: terminal } })

async function workerOnItsOwnTicket(key: string, terminal: string, pr: Pr = greenCodePr(key), how: 'dispatched' | 'claimedInItsTerminal' = 'dispatched', channel = key.toLowerCase()) {
  const id = await newTask(key, channel)
  const worktree = join(tmp, `repo-${key.toLowerCase()}`)
  await git(repo, 'worktree', 'add', '-q', '-b', `wt/${key.toLowerCase()}`, worktree, 'main')
  await writeFile(join(tmp, 'workers', `${terminal}.json`), JSON.stringify({ state: 'live', name: key.toLowerCase(), cwd: worktree, labels: {} }))
  if (how === 'dispatched') {
    await dispatchedTo(id, terminal)
    await boardCliAsSession('aaaa1111-0000', worktree, 'claim', key)
  } else await boardCliAsSessionIn(terminal, 'aaaa1111-0000', worktree, 'claim', key)
  await writeFile(join(tmp, `pr-${key}.json`), JSON.stringify(pr))
  return { id, worktree }
}

async function mergeAsTheWorker(key: string, terminal: string, worktree: string, extra: Record<string, string> = {}, wait = '0s', more: string[] = []) {
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
  const r = await exec('node', [CLI, 'merge', '5', '--wait', wait, ...more], { cwd: worktree, env }).then(
    (ok) => ({ code: 0, ...ok }),
    (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }),
  )
  const read = async (f: string) => (existsSync(f) ? await readFile(f, 'utf8') : '')
  return { ...r, hc: await read(hcLog), gh: await read(ghLog), ghTokens: (await read(`${ghLog}.tokens`)).trim().split('\n') }
}

const lastNote = async (id: string) => (await replies(id)).at(-1)?.text ?? ''
const ORCH_SESSION = 'orch0000-0000'

async function ticketTheCliOwns(key: string, channel: string, assignedTo?: string) {
  const { stdout } = await boardCliAsSession(ORCH_SESSION, repo, 'create', key, '--title', key, '--project', channel, '--json')
  const id: string = JSON.parse(stdout).task.id
  if (assignedTo) await boardCliAsSession(ORCH_SESSION, repo, 'board', 'tasks', 'assign', id, assignedTo)
  return id
}

const holderOf = async (id: string) => (await team.thread(id)).message.task?.claim?.actor ?? null
const stateOf = async (id: string) => (await team.thread(id)).message.task?.state

const SHORTEST_LEASE_THE_BOARD_TAKES_MS = 30_000

it('claims again a ticket whose lease ran out in its hands while the review ran, but not one another session claimed after it', async () => {
  const mine = await workerOnItsOwnTicket('M-LAPSED', 't65')
  const taken = await workerOnItsOwnTicket('M-TAKEN', 't64')
  await boardCliAsSession('aaaa1111-0000', mine.worktree, 'claim', 'M-LAPSED', '--release')
  await boardCliAsSession('aaaa1111-0000', taken.worktree, 'claim', 'M-TAKEN', '--release')
  await boardCliAsSession('aaaa1111-0000', mine.worktree, 'board', 'tasks', 'claim', mine.id, '--as', 'cc-aaaa1111', '--lease', '30s')
  await boardCliAsSession('other000-0000', taken.worktree, 'board', 'tasks', 'claim', taken.id, '--as', 'cc-other000', '--lease', '30s')
  await new Promise((wake) => setTimeout(wake, SHORTEST_LEASE_THE_BOARD_TAKES_MS + 1000))
  const lapsed = await mergeAsTheWorker('M-LAPSED', 't65', mine.worktree)
  expect(lapsed.stderr).toBe('')
  expect(lapsed.code).toBe(0)
  expect(lapsed.gh).toMatch(/^pr merge 5/m)
  expect(await stateOf(mine.id)).toBe('completed')
  const refused = await mergeAsTheWorker('M-TAKEN', 't64', taken.worktree)
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain('M-TAKEN 不在 cc-aaaa1111 手里')
  expect(refused.gh).not.toMatch(/^pr merge/m)
}, 90_000)

it('waits on a check still running: exit 3, no merge, no one told', async () => {
  const pr = { ...greenCodePr('M-WAIT'), statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' }] }
  const { id, worktree } = await workerOnItsOwnTicket('M-WAIT', 't70', pr)
  const r = await mergeAsTheWorker('M-WAIT', 't70', worktree)
  expect(r.code).toBe(3)
  expect(r.stderr).toMatchInlineSnapshot(`
    "✗ PR #5 还在等：CI 还在跑：test
      过一会儿再跑 nawaban merge 5
    "
  `)
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
  expect(running.stderr).toContain('CI 还在跑：ci')
})

it('refuses a ticket the merging session does not hold, before anything changes', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-THEIRS', 't66')
  await boardCliAsSession('aaaa1111-0000', worktree, 'claim', 'M-THEIRS', '--release')
  await boardCliAsSession('other000-0000', worktree, 'claim', 'M-THEIRS')
  expect(id).toBeTruthy()
  const r = await mergeAsTheWorker('M-THEIRS', 't66', worktree)
  expect(r.code).toBe(1)
  expect(r.stderr).toMatchInlineSnapshot(`
    "✗ 拒合 PR #5：M-THEIRS 不在 cc-aaaa1111 手里：持票的 worker 才能合并（先 claim）
      修好后重跑 nawaban merge 5
    "
  `)
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

it('tells the orchestrator the dispatch recorded when this repository has none, as tell does', async () => {
  const pr = { ...greenCodePr('M-FAR'), statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }
  const { id, worktree } = await workerOnItsOwnTicket('M-FAR', 't7f', pr)
  await note(id, block('nawaban-dispatch@2', { worker: 'm-far', terminal: 't7f', accept: 'a', orchestrator: 'tfar', agent: 'claude', model: 'opus' }))
  await writeFile(join(tmp, 'workers', 'tfar.json'), JSON.stringify({ state: 'live', name: 'far', cwd: tmp, labels: { role: 'orchestrator' } }))
  const r = await mergeAsTheWorker('M-FAR', 't7f', worktree, { HC_ORCH_CWD: tmp })
  expect(r.code).toBe(1)
  expect(r.hc.match(/^send .*$/gm)).toEqual(['send tfar M-FAR PR #5 merge: 拒合 — CI 没过：test'])
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
  const [, ...everyGhCallAfterAskingTheKeyring] = r.ghTokens
  expect(r.gh.split('\n')[0]).toBe('auth token --user victorGPT')
  expect(new Set(everyGhCallAfterAskingTheKeyring)).toEqual(new Set(['tok-declared']))
  expect(await stateOf(id)).toBe('completed')
})

it('prints one object for --json, merged or waiting', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-JSON', 't7j')
  const merged = await mergeAsTheWorker('M-JSON', 't7j', worktree, {}, '0s', ['--json'])
  expect([merged.code, merged.stderr]).toEqual([0, ''])
  expect(JSON.parse(merged.stdout)).toMatchObject({ pr: 5, ticket: 'M-JSON', retired: 't7j' })
  const pr = { ...greenCodePr('M-JSONW'), statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: '' }] }
  const waiting = await workerOnItsOwnTicket('M-JSONW', 't7w', pr)
  const r = await mergeAsTheWorker('M-JSONW', 't7w', waiting.worktree, {}, '0s', ['--json'])
  expect([r.code, r.stdout, JSON.parse(r.stderr)]).toEqual([3, '', { error: 'PR #5 还在等：CI 还在跑：test', next: '过一会儿再跑 nawaban merge 5', code: 3 }])
})

it('merges a green reviewed PR, pulls the main checkout, closes the ticket with its link, and retires the worker last once the wait finds nothing ready', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-GO', 't74')
  await upstreamCommit('landed M-GO')
  const r = await mergeAsTheWorker('M-GO', 't74', worktree, {}, '1s')
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.stdout).toMatchInlineSnapshot(`
    "✓ 已合 PR #5，主检出已 pull，M-GO 已关，收 worker t74
    "
  `)
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

it('retires the worker on a rerun once its worktree is gone, leaving a ticket assigned to it unclaimed', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-GONE', 't77', greenCodePr('M-GONE'), 'dispatched', 'gone-chan')
  const first = await mergeAsTheWorker('M-GONE', 't77', worktree, { HC_KILL_FAIL: '1' })
  expect(first.code).toBe(1)
  expect(existsSync(worktree)).toBe(false)
  const next = await ticketTheCliOwns('M-GONE-NEXT', 'gone-chan', 'cc-aaaa1111')
  await writeFile(join(tmp, 'pr-M-GONE.json'), JSON.stringify({ ...greenCodePr('M-GONE'), state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } }))
  const rerun = await mergeAsTheWorker('M-GONE', 't77', repo)
  expect(rerun.code).toBe(0)
  expect(rerun.hc.trim().split('\n').at(-1)).toBe('kill t77')
  expect(await holderOf(next)).toBeNull()
})

it('refuses when the head is not readable locally, so its workflows can not be skipped unseen', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-UNSEEN', 't64', { ...greenCodePr('M-UNSEEN'), headRefOid: '1234567890abcdef1234567890abcdef12345678', comments: [{ body: 'Codex review：无挡 1234567890ab' }] })
  const r = await mergeAsTheWorker('M-UNSEEN', 't64', worktree)
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('本地读不到 head')
  expect(r.gh).not.toMatch(/^pr merge/m)
})

it('counts a worker that has already exited as retired on a rerun, even with its worktree left', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-EXITED', 't78')
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

it('claims the ticket assigned to it once merged, ahead of an older one in the pool, and prints the brief to carry on, pushing nothing', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-LN', 't75', greenCodePr('M-LN'), 'dispatched', 'ln-chan')
  const pool = await ticketTheCliOwns('M-LN-POOL', 'ln-chan')
  const next = await ticketTheCliOwns('M-LN-NEXT', 'ln-chan', 'cc-aaaa1111')
  await note(next, block('nawaban-dispatch@2', { worker: 'm-ln', terminal: 't75', accept: 'next is done', orchestrator: ORCH, agent: 'claude', model: 'opus' }))
  await note(next, '派发 brief：carry the next one')
  const r = await mergeAsTheWorker('M-LN', 't75', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await stateOf(id)).toBe('completed')
  expect(r.hc).not.toMatch(/^(kill|send)/m)
  expect(await holderOf(next)).toMatch(/\+cc-aaaa1111$/)
  expect((await team.thread(next)).message.labels.terminal).toBe('t75')
  expect(await holderOf(pool)).toBeNull()
  expect(r.stdout).toContain('任务：M-LN-NEXT')
  expect(r.stdout).toContain(`接着用 ${worktree}，先 git fetch origin main && git switch -c wt/m-ln-next origin/main`)
  expect(r.stdout).toContain('carry the next one')
  expect(r.stdout).toContain('验收：next is done')
  expect(r.stdout).toContain(`event M-LN-NEXT impact --o`)
  expect(r.stdout).not.toContain('next turn')
  expect(await lastNote(id)).toMatch(/领到下一张 M-LN-NEXT/)
  expect(existsSync(worktree)).toBe(true)
})

it('retires a worker that took its ticket without a dispatch, found by the terminal it claimed from, once nothing is ready for it', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-SELF', 't79', greenCodePr('M-SELF'), 'claimedInItsTerminal')
  const r = await mergeAsTheWorker('M-SELF', 't79', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await lastNote(id)).toMatch(/收 worker t79/)
  expect(existsSync(worktree)).toBe(false)
  expect(r.hc.trim().split('\n').at(-1)).toBe('kill t79')
})

it('leaves an unassigned ticket in the pool and retires the worker once nothing is assigned to it within the wait', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-SELFN', 't7a', greenCodePr('M-SELFN'), 'claimedInItsTerminal', 'selfn-chan')
  const pooled = await ticketTheCliOwns('M-SELFN-NEXT', 'selfn-chan')
  const r = await mergeAsTheWorker('M-SELFN', 't7a', worktree, {}, '1s')
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await holderOf(pooled)).toBeNull()
  expect(existsSync(worktree)).toBe(false)
  expect(r.hc.trim().split('\n').at(-1)).toBe('kill t7a')
})

it('claims a ticket assigned to it while its merge waits', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-LATE', 't7k', greenCodePr('M-LATE'), 'dispatched', 'late-chan')
  const late = await ticketTheCliOwns('M-LATE-NEXT', 'late-chan')
  const merging = mergeAsTheWorker('M-LATE', 't7k', worktree, {}, '20s')
  await new Promise((r) => setTimeout(r, 3000))
  await boardCliAsSession(ORCH_SESSION, repo, 'board', 'tasks', 'assign', late, 'cc-aaaa1111')
  const r = await merging
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await holderOf(late)).toMatch(/\+cc-aaaa1111$/)
  expect(r.hc).not.toMatch(/^kill/m)
}, 40_000)

it('finishes retiring a worker that took its ticket without a dispatch on a rerun after the close unset its terminal label', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-SELFK', 't7b', greenCodePr('M-SELFK'), 'claimedInItsTerminal')
  const first = await mergeAsTheWorker('M-SELFK', 't7b', worktree, { HC_KILL_FAIL: '1' })
  expect(first.code).toBe(1)
  expect(await stateOf(id)).toBe('completed')
  await writeFile(join(tmp, 'pr-M-SELFK.json'), JSON.stringify({ ...greenCodePr('M-SELFK'), state: 'MERGED', mergeCommit: { oid: 'f'.repeat(40) } }))
  const rerun = await mergeAsTheWorker('M-SELFK', 't7b', repo)
  expect(rerun.code).toBe(0)
  expect(rerun.hc.trim().split('\n').at(-1)).toBe('kill t7b')
})

it('reads a terminal label left by a lapsed claim as no holder, so the worker claims that ticket rather than being kept for it', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-STALE', 't7c', greenCodePr('M-STALE'), 'claimedInItsTerminal', 'stale-chan')
  const next = await ticketTheCliOwns('M-STALE-NEXT', 'stale-chan', 'cc-aaaa1111')
  await team.as(null).label(next, { set: { terminal: 't7c' } })
  const r = await mergeAsTheWorker('M-STALE', 't7c', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.hc).not.toMatch(/^kill/m)
  expect(await holderOf(next)).toMatch(/\+cc-aaaa1111$/)
})

it('leaves a worker alone that still holds another open ticket from its terminal', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-BUSY', 't7e')
  await newTask('M-BUSY-OTHER', 'm-busy')
  await boardCliAsSessionIn('t7e', 'aaaa1111-0000', worktree, 'claim', 'M-BUSY-OTHER')
  const r = await mergeAsTheWorker('M-BUSY', 't7e', worktree)
  expect(r.code).toBe(0)
  expect(await stateOf(id)).toBe('completed')
  expect(r.hc).not.toMatch(/^(kill|send)/m)
  expect(await lastNote(id)).toContain('t7e 还有 M-BUSY-OTHER，留着')
  expect(existsSync(worktree)).toBe(true)
})

it('keeps the worker and tells the orchestrator when claiming its next ticket fails, rather than reading the failure as nothing ready', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-CLAIMERR', 't7d')
  const r = await mergeAsTheWorker('M-CLAIMERR', 't7d', worktree, {}, 'soon')
  expect(r.code).toBe(1)
  expect(await stateOf(id)).toBe('completed')
  expect(r.stderr).toContain("领下一张出错，worker t7d 留着：--wait 要写成 30s、10m、1h 这样的时长，不是 soon")
  expect(r.hc).not.toMatch(/^kill/m)
  expect(r.hc).toMatch(/^send to1 M-CLAIMERR PR #5 merge: 已合未收完 — 领下一张出错/m)
  expect(existsSync(worktree)).toBe(true)
})

const labelTheWorkerWithItsSession = (terminal: string, worktree: string) =>
  writeFile(join(tmp, 'workers', `${terminal}.json`), JSON.stringify({ state: 'live', name: terminal, cwd: worktree, labels: { 'revive.agent': 'claude', 'revive.session': 'aaaa1111-0000' } }))

it('claims nothing for the worker when merge runs from another terminal, and leaves it with its worktree', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-ELSE', 't7g', greenCodePr('M-ELSE'), 'dispatched', 'else-chan')
  await labelTheWorkerWithItsSession('t7g', worktree)
  const assigned = await ticketTheCliOwns('M-ELSE-NEXT', 'else-chan', 'cc-aaaa1111')
  const pooled = await ticketTheCliOwns('M-ELSE-POOL', 'else-chan')
  const r = await mergeAsTheWorker('M-ELSE', 't7g', worktree, { HC_TERMINAL_ID: 'tother' })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await holderOf(assigned)).toBeNull()
  expect(await holderOf(pooled)).toBeNull()
  expect(r.hc).not.toMatch(/^kill/m)
  expect(existsSync(worktree)).toBe(true)
  expect(await lastNote(id)).toMatch(/worker t7g 留着：merge 不在它的终端里跑/)
})

it('keeps a worker that claimed a ticket while its merge waited, rather than retiring it once the wait runs out', async () => {
  const { id, worktree } = await workerOnItsOwnTicket('M-RACE', 't7j')
  const side = await newTask('M-RACE-SIDE', 'm-race')
  const merging = mergeAsTheWorker('M-RACE', 't7j', worktree, {}, '4s')
  await new Promise((r) => setTimeout(r, 2500))
  await boardCliAsSessionIn('t7j', 'aaaa1111-0000', worktree, 'board', 'tasks', 'claim', side, '--as', 'cc-aaaa1111')
  const r = await merging
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.hc).not.toMatch(/^kill/m)
  expect(existsSync(worktree)).toBe(true)
  expect(await lastNote(id)).toContain('t7j 还有 M-RACE-SIDE，留着')
})

it('keeps a worker that holds a claim its terminal label never reached, so a rerun claims no second ticket', async () => {
  const { worktree } = await workerOnItsOwnTicket('M-UNLAB', 't7i', greenCodePr('M-UNLAB'), 'dispatched', 'unlab-chan')
  const held = await ticketTheCliOwns('M-UNLAB-HELD', 'unlab-chan')
  await boardCliAsSession('aaaa1111-0000', worktree, 'board', 'tasks', 'claim', held, '--as', 'cc-aaaa1111')
  const spare = await ticketTheCliOwns('M-UNLAB-SPARE', 'unlab-chan')
  const r = await mergeAsTheWorker('M-UNLAB', 't7i', worktree)
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await holderOf(spare)).toBeNull()
  expect(r.hc).not.toMatch(/^kill/m)
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
  expect(r.stderr).toContain('插件要拉进来的改动里有 schema')
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

const claimReadyIn = (cwd: string, argv: string[], env: Record<string, string> = {}) =>
  exec('node', [CLI, 'claim', '--ready', ...argv], { cwd, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, CLAUDE_CODE_SESSION_ID: 'bbbb2222-0000', HC_TERMINAL_ID: 't7h', ...env } }).then(
    (ok) => ({ code: 0, ...ok }),
    (error) => ({ code: error.code as number, stdout: error.stdout as string, stderr: error.stderr as string }),
  )

it('claims an unassigned ticket from the pool with claim --ready, and prints the brief to carry on in this worktree', async () => {
  const id = await ticketTheCliOwns('C-POOL', 'claim-pool')
  const r = await claimReadyIn(repo, ['--project', 'claim-pool'])
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(r.stdout).toMatch(/^✓ 领到 C-POOL\s+claimed\s+C-POOL/)
  expect(r.stdout).toContain(`接着用 ${repo}，先 git fetch origin main && git switch -c wt/c-pool origin/main`)
  expect(r.stdout).toContain('先跑 nawaban event C-POOL impact')
  expect(r.stdout).toContain('nawaban merge <PR 号>')
  expect(r.stdout).not.toContain('cli.ts')
  expect(await holderOf(id)).toMatch(/\+cc-bbbb2222$/)
  expect((await team.thread(id)).message.labels.terminal).toBe('t7h')
  const closed = await exec('node', [CLI, 'close', 'C-POOL', '--done'], { cwd: repo, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, NAWABAN_BOARD_DIR: join(tmp, 'board'), CLAUDE_CODE_SESSION_ID: 'bbbb2222-0000', HC_TERMINAL_ID: '' } })
  expect(closed.stdout).toBe('✓ 关了 C-POOL（做完）\n')
  expect(await stateOf(id)).toBe('completed')
})

it('prints the claimed ticket and its brief as one object for claim --ready --json', async () => {
  await ticketTheCliOwns('C-JSON', 'claim-json')
  const r = await claimReadyIn(repo, ['--project', 'claim-json', '--json'])
  expect([r.code, r.stderr]).toEqual([0, ''])
  const { task, brief } = JSON.parse(r.stdout)
  expect([task.labels.key, brief]).toEqual(['C-JSON', expect.stringContaining('先跑 nawaban event C-JSON impact')])
})

it('takes the project of this checkout from repos.json when claim --ready names none', async () => {
  const dir = join(tmp, 'claim-board')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'repos.json'), JSON.stringify({ 'claim-home': repo }))
  const id = await ticketTheCliOwns('C-HOME', 'claim-home')
  const r = await claimReadyIn(repo, [], { NAWABAN_BOARD_DIR: dir })
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  expect(await holderOf(id)).toMatch(/\+cc-bbbb2222$/)
})

it('exits 1 with the next step on stderr when claim --ready finds nothing ready within its wait', async () => {
  const r = await claimReadyIn(repo, ['--project', 'claim-none', '--wait', '1s'])
  expect(r.code).toBe(1)
  expect(r.stdout).toBe('')
  expect(r.stderr).toBe('✗ claim-none 里没有给 cc-bbbb2222 的票，等了 1s\n  等编排者派，或过会儿再跑 nawaban claim --ready\n')
})

it('reports a board claim --ready can not reach as an error, never as nothing ready', async () => {
  const r = await claimReadyIn(repo, ['--project', 'claim-none'], { BOARD_URL: 'http://127.0.0.1:9/api/board' })
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('在 claim-none 领下一张失败')
  expect(r.stderr).not.toContain('里没有给')
})

it.each([{ argv: ['C-POOL'] }, { argv: ['--o', '无'] }, { argv: ['--release'] }])('refuses claim --ready with $argv', async ({ argv }) => {
  expect((await claimReadyIn(repo, argv)).code).toBe(2)
})


async function workerWithChecksOnItsHead(key: string, terminal: string, checks: string[]) {
  const w = await workerOnItsOwnTicket(key, terminal)
  const head = (await git(w.worktree, 'rev-parse', 'HEAD')).stdout.trim()
  await writeFile(join(tmp, `pr-${key}.json`), JSON.stringify({ ...greenCodePr(key), headRefOid: head, comments: [{ body: `Codex review：无挡合并（${head.slice(0, 7)}）` }] }))
  await note(w.id, `验收检查：${JSON.stringify(checks)}`)
  return { ...w, head }
}

it('runs the ticket\'s checks with the board\'s tasks run, then merges, the run completing the ticket', async () => {
  const { id, worktree, head } = await workerWithChecksOnItsHead('M-CHK', 't7c', ['echo first passes', 'test "$BOARD_TASK" != ""'])
  const r = await mergeAsTheWorker('M-CHK', 't7c', worktree)
  expect([r.code, r.stderr]).toEqual([0, ''])
  expect(r.gh).toContain(`pr merge 5 --squash --match-head-commit ${head}`)
  expect(await stateOf(id)).toBe('completed')
  expect((await team.thread(id)).message.task?.result).toBe('验收检查全过，已合 PR #5')
  expect(r.stdout).toContain('M-CHK 已关')
})

it('refuses on a failing check: no merge, the ticket failed with the output tail on it, and a rerun after the fix reopens it and merges', async () => {
  const fixed = join(tmp, 'm-chk-red-fixed')
  const { id, worktree } = await workerWithChecksOnItsHead('M-CHKRED', 't7d', ['echo fine', `echo boom-\$BOARD_TASK; test -f ${fixed} || exit 7`, 'echo never'])
  const red = await mergeAsTheWorker('M-CHKRED', 't7d', worktree)
  expect(red.code).toBe(1)
  expect(red.gh).not.toMatch(/^pr merge/m)
  expect(await stateOf(id)).toBe('failed')
  expect((await team.thread(id)).message.task?.reason).toBe('exited 7')
  const tail = await lastNote(id)
  expect(tail).toContain('merge: 拒合 — 验收检查没过，票记 failed（exited 7）')
  expect(tail).toContain(`boom-${id}`)
  expect(tail).not.toContain('never')
  await writeFile(fixed, '')
  const green = await mergeAsTheWorker('M-CHKRED', 't7d', worktree)
  expect([green.code, green.stderr]).toEqual([0, ''])
  expect(green.gh).toMatch(/^pr merge 5/m)
  expect(await stateOf(id)).toBe('completed')
})

it('runs the checks from the repository root even when merge runs in a subdirectory', async () => {
  const { id, worktree } = await workerWithChecksOnItsHead('M-CHKROOT', 't7j', ['test "$(pwd -P)" = "$(git rev-parse --show-toplevel)"'])
  await mkdir(join(worktree, 'sub'))
  const r = await mergeAsTheWorker('M-CHKROOT', 't7j', join(worktree, 'sub'))
  expect([r.code, r.stderr]).toEqual([0, ''])
  expect(await stateOf(id)).toBe('completed')
})

async function githubFailingTheMerge(key: string, errors: string[]) {
  const fails = join(tmp, `merge-fails-${key}`)
  const sleeps = join(tmp, `sleeps-${key}`)
  await mkdir(sleeps)
  await writeFile(join(sleeps, 'sleep'), `#!/bin/sh\nprintf '%s\\n' "$1" >> "${sleeps}/log"\n`)
  await chmod(join(sleeps, 'sleep'), 0o755)
  await writeFile(fails, errors.map((e) => `${e}\n`).join(''))
  return { env: { GH_MERGE_FAILS: fails, PATH: `${sleeps}:${tmp}:${process.env.PATH}` }, pauses: async () => (await readFile(join(sleeps, 'log'), 'utf8').catch(() => '')).split('\n').filter(Boolean) }
}

it('retries a GitHub hiccup on the merge with backoff, then merges and completes the ticket', async () => {
  const { id, worktree } = await workerWithChecksOnItsHead('M-HICCUP', 't7g', ['true'])
  const github = await githubFailingTheMerge('M-HICCUP', ['GraphQL: Something went wrong while executing your query. (mergePullRequest)'])
  const r = await mergeAsTheWorker('M-HICCUP', 't7g', worktree, github.env)
  expect([r.code, r.stderr]).toEqual([0, ''])
  expect(r.gh.match(/^pr merge/gm)).toHaveLength(2)
  expect(await github.pauses()).toEqual(['2'])
  expect(await stateOf(id)).toBe('completed')
})

it('reports a merge GitHub keeps failing as a merge failure, not failed checks: the ticket stays claimed and a rerun merges', async () => {
  const { id, worktree } = await workerWithChecksOnItsHead('M-GHDOWN', 't7h', ['echo checks-ran'])
  const github = await githubFailingTheMerge('M-GHDOWN', Array(4).fill('HTTP 502: Bad Gateway (https://api.github.com/graphql)'))
  const down = await mergeAsTheWorker('M-GHDOWN', 't7h', worktree, github.env)
  expect(down.code).toBe(1)
  expect(down.gh.match(/^pr merge/gm)).toHaveLength(4)
  expect(await github.pauses()).toEqual(['2', '4', '8'])
  expect(down.stderr).toContain('合并失败（GitHub）')
  expect(down.stderr).not.toContain('验收检查没过')
  expect(await stateOf(id)).toBe('claimed')
  expect(await holderOf(id)).toMatch(/\+cc-aaaa1111$/)
  const tail = await lastNote(id)
  expect(tail).toContain('merge: 拒合 — 合并失败（GitHub）')
  expect(tail).toContain('HTTP 502: Bad Gateway')
  const up = await mergeAsTheWorker('M-GHDOWN', 't7h', worktree, github.env)
  expect([up.code, up.stderr]).toEqual([0, ''])
  expect(await stateOf(id)).toBe('completed')
})

it('does not retry a merge GitHub refuses for good', async () => {
  const { id, worktree } = await workerWithChecksOnItsHead('M-UNMERGEABLE', 't7i', ['true'])
  const github = await githubFailingTheMerge('M-UNMERGEABLE', ['Pull request #5 is not mergeable: the merge commit cannot be cleanly created.'])
  const r = await mergeAsTheWorker('M-UNMERGEABLE', 't7i', worktree, github.env)
  expect(r.code).toBe(1)
  expect(r.gh.match(/^pr merge/gm)).toHaveLength(1)
  expect(await github.pauses()).toEqual([])
  expect(r.stderr).toContain('合并失败（GitHub）')
  expect(await stateOf(id)).toBe('claimed')
})

it('refuses to run the checks off the PR head, before the ticket is let go', async () => {
  const { id, worktree } = await workerWithChecksOnItsHead('M-CHKDIRTY', 't7e', ['true'])
  await writeFile(join(worktree, 'stray'), '')
  const r = await mergeAsTheWorker('M-CHKDIRTY', 't7e', worktree)
  expect(r.code).toBe(1)
  expect(r.stderr).toContain('工作区有没提交的改动')
  expect(r.gh).not.toMatch(/^pr merge/m)
  expect(await stateOf(id)).toBe('claimed')
})


it('reads a check that sets -e as failing, never reaching the merge', async () => {
  const { id, worktree } = await workerWithChecksOnItsHead('M-CHKSETE', 't7f', ['set -e; false; echo PASS'])
  const r = await mergeAsTheWorker('M-CHKSETE', 't7f', worktree)
  expect(r.code).toBe(1)
  expect(r.gh).not.toMatch(/^pr merge/m)
  expect(await stateOf(id)).toBe('failed')
  expect((await lastNote(id)).split('\n')).not.toContain('PASS')
})

it('refuses to let the checks close a ticket whose registered KRs have no result, and takes them on merge --kr', async () => {
  const okrRepo = join(tmp, 'okr-repo')
  await mkdir(join(okrRepo, 'docs/agents'), { recursive: true })
  await writeFile(join(okrRepo, 'docs/agents/okr.toml'), '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 95"\nmeasure = "cat k.txt"\n')
  const reposFile = join(tmp, 'board', 'repos.json')
  const repos = existsSync(reposFile) ? JSON.parse(await readFile(reposFile, 'utf8')) : {}
  await writeFile(reposFile, JSON.stringify({ ...repos, 'm-chkkr': okrRepo }))
  const { id, worktree } = await workerWithChecksOnItsHead('M-CHKKR', 't7g', ['true'])
  await exec('node', [CLI, 'event', 'M-CHKKR', 'impact', '--o', 'O', '--kr', 'K=toward'], { cwd: worktree, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: SECRET, XDG_CONFIG_HOME: tmp, NAWABAN_BOARD_DIR: join(tmp, 'board'), CLAUDE_CODE_SESSION_ID: 'aaaa1111-0000' } })
  const unreported = await mergeAsTheWorker('M-CHKKR', 't7g', worktree)
  expect(unreported.code).toBe(1)
  expect(unreported.stderr).toContain('没补结果(K)')
  expect(unreported.stderr).toContain('nawaban merge 5 --kr')
  expect(unreported.gh).not.toMatch(/^pr merge/m)
  expect(await stateOf(id)).toBe('claimed')
  const reported = await mergeAsTheWorker('M-CHKKR', 't7g', worktree, {}, '0s', ['--kr', 'K=96 实测'])
  expect([reported.code, reported.stderr]).toEqual([0, ''])
  expect(await stateOf(id)).toBe('completed')
})
