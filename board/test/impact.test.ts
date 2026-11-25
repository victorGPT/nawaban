import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createApp } from '@vercel/board/cli'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'
import { claimRegistering, event } from '../src/events.ts'
import { jsonOkr, okr } from '../src/okr.ts'
import { closeGate, impactNames } from '../src/impact.ts'
import { run } from '../src/tasks.ts'

const SECRET = 'test-secret'
const HOOK = join(import.meta.dirname, '../../hooks/board-impact-guard.sh')
const EVERY_HOOK_RUN_STARTS_A_SHELL_AND_TWO_NODES = { timeout: 60_000 }
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let url = ''
let dir = ''
let repo = ''
let worktree = ''
let bin = ''

const OKR = `[[objective]]
name = "O1"
[[objective.kr]]
name = "KR1"
[[objective.kr]]
name = "KR2"
`

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'nawaban-impact-'))
  dir = join(root, 'board')
  repo = join(root, 'repo')
  await mkdir(join(repo, 'docs/agents'), { recursive: true })
  await writeFile(join(repo, 'docs/agents/okr.toml'), OKR)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'okr')
  worktree = join(root, 'wt')
  git('worktree', 'add', '-q', worktree)
  await mkdir(dir)
  await writeFile(join(dir, 'repos.json'), JSON.stringify({ nawaban: repo }))
  const ghAnsweringPrViewWithThePullRequestATestMerges = '#!/bin/sh\nprintf "%s" "$GH_PR"\n'
  bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'gh'), ghAnsweringPrViewWithThePullRequestATestMerges)
  await chmod(join(bin, 'gh'), 0o755)

  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url, middleware: [impactNames(dir)] })
  await registerSchemas(team)
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nawaban-impact-config-'))
})
afterAll(() => server.close())

async function nawaban(...argv: string[]) {
  vi.stubEnv('BOARD_URL', url)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  vi.stubEnv('NAWABAN_BOARD_DIR', dir)
  let err = ''
  let failure: { data?: { error?: { code?: string; message?: string } } } | undefined
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true))
  try {
    const app = createApp({ appName: 'nawaban', onError: (f) => void (failure = f) })
    const code = argv[0] === 'event' ? await event(argv.slice(1), (args) => app.run(args), board()) : await app.run(argv)
    const whatTheMiddlewareSaidDroppingTheWrite = failure?.data?.error?.code === 'dropped' ? failure.data.error.message : undefined
    return { code, err, failure, dropped: whatTheMiddlewareSaidDroppingTheWrite }
  } finally {
    out.mockRestore()
    stderr.mockRestore()
    vi.unstubAllEnvs()
  }
}

const newTask = async (channel = 'nawaban', key?: string) =>
  (await team.tasks.create(channel, { text: 'impact', ...(key ? { labels: { key } } : {}) })).task.id
const replies = async (id: string) => (await team.thread(id)).replies.length

it('registers an impact whose names are in the okr.toml, a product change unless told otherwise', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=toward', '--kr', 'KR2=hold')).code).toBe(0)
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=away', '--change', 'gold')).code).toBe(0)
  const { replies } = await team.thread(id)
  expect(replies.map((r) => [r.blocks[0]!.version, r.blocks[0]!.data])).toEqual([
    [2, { objective: 'O1', change: 'product', krs: [{ name: 'KR1', heading: 'toward' }, { name: 'KR2', heading: 'hold' }] }],
    [2, { objective: 'O1', change: 'gold', krs: [{ name: 'KR1', heading: 'away' }] }],
  ])
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=toward', '--change', 'code')).code).toBe(2)
})

it('registers with the kind as a word, and points the old --kind at that form, which runs as it reads', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, 'impact', '--o', 'O1', '--kr', 'KR1=toward', '--change', 'product')).code).toBe(0)
  const old = await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR2=hold', '--change', 'measure')
  expect([old.code, old.err]).toEqual([0, `改用：nawaban event ${id} impact --o O1 --kr KR2=hold --change measure\n`])
  expect((await nawaban(...old.err.replace('改用：nawaban ', '').trim().split(' '))).code).toBe(0)
  const { replies } = await team.thread(id)
  expect(replies.map((r) => r.blocks[0]!.data)).toEqual([
    { objective: 'O1', change: 'product', krs: [{ name: 'KR1', heading: 'toward' }] },
    { objective: 'O1', change: 'measure', krs: [{ name: 'KR2', heading: 'hold' }] },
    { objective: 'O1', change: 'measure', krs: [{ name: 'KR2', heading: 'hold' }] },
  ])
  expect((await nawaban('event', id, 'note', '已完成：x', '--change', 'gold')).err).toMatch('--change 只跟 impact 一起用')
})

it('refuses a KR or an O the okr.toml does not have', async () => {
  const id = await newTask()
  const kr = await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR9=toward')
  expect(kr.code).toBe(1)
  expect(kr.err).toMatch('O1 下没有这个 KR:KR9(有:KR1、KR2)')
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O9')).err).toMatch(/没有这个 O:O9/)
  expect(await replies(id)).toBe(0)
})

it("holds the board's own writers to the names, not only nawaban event", async () => {
  const id = await newTask()
  const registered = { objective: 'O1', change: 'product', krs: [{ name: 'KR9', heading: 'toward' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-impact@2', JSON.stringify(registered))).dropped).toMatch(/没有这个 KR:KR9/)
  const wrong = { objective: 'O1', krs: [{ name: 'KR9', dir: '=' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-impact@1', JSON.stringify(wrong))).dropped).toMatch(/没有这个 KR:KR9/)
  const bare = { objective: 'O1', krs: [{ name: 'KR1', dir: '↑' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-impact@1', JSON.stringify(bare))).failure?.data?.error?.code).toBe('invalid_block')
  expect(await replies(id)).toBe(0)
})

it('takes no old ↑↓= from nawaban event, and holds old blocks to numbers before and after', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=↑ 3→5 实测')).code).toBe(2)
  const words = { objective: 'O1', krs: [{ name: 'KR1', dir: '↑', before: 'low', after: 'high', basis: '预计' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-impact@1', JSON.stringify(words))).dropped).toMatch(/前后值要是数字/)
  expect(await replies(id)).toBe(0)
})

it('lets --o 无 through, with no KR, in any project', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'impact', '--o', '无')).code).toBe(0)
  expect((await nawaban('event', id, '--kind', 'impact', '--o', '无', '--kr', 'KR1=hold')).err).toMatch('--o 无 不带 --kr')
  const plain = await newTask('plain')
  expect((await nawaban('event', plain, '--kind', 'impact', '--o', '无')).code).toBe(0)
  expect((await nawaban('event', plain, '--kind', 'impact', '--o', 'O1')).err).toMatch(/没有 docs\/agents\/okr.toml/)
})

async function asAWorker(fn: () => Promise<number | undefined>) {
  for (const [k, v] of Object.entries({ BOARD_URL: url, BOARD_TOKEN: SECRET, NAWABAN_BOARD_DIR: dir, CLAUDE_CODE_SESSION_ID: 'aaaa1111-0', HC_TERMINAL_ID: '' })) vi.stubEnv(k, v)
  let out = ''
  let err = ''
  const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true)), vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true))]
  try {
    return { code: await fn(), out, err }
  } finally {
    for (const spy of quiet) spy.mockRestore()
    vi.unstubAllEnvs()
  }
}
const close = (key: string, ...more: string[]) => asAWorker(() => run(['close', key, '--done', ...more]))
const claimRegisteringAsTheCliDoes = (...argv: string[]) =>
  asAWorker(() => claimRegistering(argv, async (rest) => (await run(['claim', ...rest]))!, (args) => createApp({ appName: 'nawaban' }).run(args), board()))

it('refuses to close as done a task with no impact, where the project keeps an okr.toml', async () => {
  const id = await newTask('nawaban', 'NAWABAN-C-01')
  const refused = await close('NAWABAN-C-01')
  expect(refused.code).toBe(1)
  expect(refused.err).toMatch(/NAWABAN-C-01 没有 KR 影响声明/)
  expect((await team.thread(id)).message.task).toMatchObject({ state: 'ready', claim: null })

  await nawaban('event', id, '--kind', 'impact', '--o', '无')
  expect((await close('NAWABAN-C-01')).code).toBe(0)
  await newTask('plain', 'PLAIN-C-01')
  expect((await close('PLAIN-C-01')).code).toBe(0)
})

function preToolUseHookOnBashAsClaudeCodeRunsIt(command: string, cwd = worktree, pr = {}): Promise<{ code: number | null; err: string }> {
  return new Promise((done) => {
    const child = execFile('sh', [HOOK], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BOARD_URL: url, BOARD_TOKEN: SECRET, NAWABAN_BOARD_DIR: dir, NAWABAN_CLI: 'board', GH_PR: JSON.stringify(pr) },
    }, (error, _out, err) => done({ code: error ? (error.code as number) : 0, err }))
    child.stdin!.end(JSON.stringify({ cwd, tool_input: { command } }))
  })
}

it("stops an agent closing a task with the board's CLI", EVERY_HOOK_RUN_STARTS_A_SHELL_AND_TWO_NODES, async () => {
  for (const cmd of ['vb tasks complete 12', 'cd x && npx vb tasks fail 3 boom', 'nawaban --as cc-1 tasks cancel 4', 'vercel board tasks complete 5', 'npx --yes @vercel/board tasks complete 12', 'pnpm --silent dlx @vercel/board@0.53.0 tasks fail 1 x', 'nawaban board tasks complete 12', 'node ~/.nawaban/plugin/board/src/cli.ts board tasks cancel 4 x']) {
    expect([cmd, closeGate(cmd)]).toEqual([cmd, expect.stringMatching(/nawaban close/)])
  }
  for (const cmd of ['nawaban close NAWABAN-X --done', 'vb tasks list', 'echo "vb tasks complete 1"', 'git commit -m "tasks complete"', 'echo board tasks complete', 'printf "%s\\n" nawaban tasks complete']) {
    expect([cmd, closeGate(cmd)]).toEqual([cmd, null])
  }
  const refused = await preToolUseHookOnBashAsClaudeCodeRunsIt('vb tasks complete 12')
  expect(refused.code).toBe(2)
  expect(refused.err).toMatch(/nawaban close/)
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('ls')).code).toBe(0)
})

it('refuses a merge whose task declares no impact, from a worktree of the repository', EVERY_HOOK_RUN_STARTS_A_SHELL_AND_TWO_NODES, async () => {
  const id = await newTask('nawaban', 'NAWABAN-T-01')
  const pr = { number: 7, title: 'feat: x', body: 'Refs NAWABAN-T-01', headRefName: 'feat/x' }
  const refused = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7 --squash', worktree, pr)
  expect(refused.code).toBe(2)
  expect(refused.err).toMatch(/NAWABAN-T-01/)

  await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=hold')
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7 --squash', worktree, pr)).code).toBe(0)
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7', worktree, { ...pr, body: 'no key' })).code).toBe(2)
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('echo "gh pr merge 7"', worktree, pr)).code).toBe(0)

  await (await team.tasks.claim(id)).complete('done')
  const doneStillHasItsDeclaration = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7 --squash', worktree, pr)
  expect(doneStillHasItsDeclaration.code).toBe(0)
})

it('checks only the tickets a merge is for, not one its body mentions in passing', EVERY_HOOK_RUN_STARTS_A_SHELL_AND_TWO_NODES, async () => {
  const own = await newTask('nawaban', 'NAWABAN-M-01')
  await newTask('nawaban', 'NAWABAN-M-02')
  await newTask('nawaban', 'NAWABAN-M-03')
  const pr = { number: 9, title: '收尾（NAWABAN-M-01）', body: '删别名另开 NAWABAN-M-02，父票 NAWABAN-M-03。', headRefName: 'wt/nawaban-m-01' }
  const undeclaredOwn = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 9', worktree, pr)
  expect([undeclaredOwn.code, undeclaredOwn.err]).toEqual([2, expect.stringContaining('(NAWABAN-M-01)')])
  await nawaban('event', own, '--kind', 'impact', '--o', '无')
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 9', worktree, pr)).code).toBe(0)
  const referenced = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 9', worktree, { ...pr, body: '收尾。\n\nRefs NAWABAN-M-02' })
  expect([referenced.code, referenced.err]).toEqual([2, expect.stringContaining('(NAWABAN-M-02)')])
  const onlyTheBranch = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 9', worktree, { ...pr, title: 'x', body: '' })
  expect(onlyTheBranch.code).toBe(0)
})

it("reads gh's -R before pr merge as a merge", EVERY_HOOK_RUN_STARTS_A_SHELL_AND_TWO_NODES, async () => {
  await newTask('nawaban', 'NAWABAN-T-02')
  const pr = { number: 8, title: 'NAWABAN-T-02', body: '', headRefName: 'x' }
  const refused = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh -R acme/web pr merge 8 --squash', worktree, pr)
  expect(refused.code).toBe(2)
  expect(refused.err).toMatch(/NAWABAN-T-02/)
})

it('refuses to close as done a task that registered KRs and never reported them, and takes the results as it closes', async () => {
  const id = await newTask('nawaban', 'NAWABAN-R-01')
  await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=toward', '--kr', 'KR2=hold')
  const unreported = await close('NAWABAN-R-01')
  expect([unreported.code, unreported.err]).toEqual([1, expect.stringMatching(/登记了 KR 却没补结果\(KR1、KR2\)/)])
  expect((await close('NAWABAN-R-01', '--kr', 'KR1=up')).code).toBe(2)
  expect((await close('NAWABAN-R-01', '--kr', 'KR1=5 实测')).err).toMatch(/没补结果\(KR2\)/)
  expect((await close('NAWABAN-R-01', '--kr', 'KR2=83.3% 预计')).code).toBe(0)
})

it('writes no result for a ticket someone else holds', async () => {
  const id = await newTask('nawaban', 'NAWABAN-R-03')
  await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=toward')
  await team.as('someone-else').tasks.claim(id)
  expect((await close('NAWABAN-R-03', '--kr', 'KR1=999 实测')).err).toMatch(/^✗ NAWABAN-R-03 在 someone-else 手里/)
  expect((await team.thread(id)).replies.flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact-result')).toEqual([])
})

it('registers as it claims, refusing a wrong name before it claims', async () => {
  const id = await newTask('nawaban', 'NAWABAN-R-02')
  const wrong = await claimRegisteringAsTheCliDoes('NAWABAN-R-02', '--o', 'O1', '--kr', 'KR9=toward')
  expect([wrong.code, (await team.thread(id)).message.task?.state]).toEqual([1, 'ready'])
  expect((await claimRegisteringAsTheCliDoes('NAWABAN-R-02', '--o', 'O1', '--kr', 'KR1=toward', '--change', 'measure')).code).toBe(0)
  const { message, replies } = await team.thread(id)
  expect([message.task?.state, replies.at(-1)!.blocks[0]!.data]).toEqual(['claimed', { objective: 'O1', change: 'measure', krs: [{ name: 'KR1', heading: 'toward' }] }])
})

describe('end to end: registered as claimed, reported as closed, judged by json okr', () => {
  let e2e = ''
  const measure = async (value: number, day: number) => {
    await writeFile(join(e2e, 'k.txt'), `${value} 2026-11-${day}`)
    return asAWorker(() => okr([], team, dir, { cwd: e2e }))
  }
  const verdicts = async () => JSON.parse((await asAWorker(() => jsonOkr([], team, dir, e2e))).out).objectives[0].krs[0].verdicts

  beforeAll(async () => {
    e2e = await mkdtemp(join(tmpdir(), 'nawaban-impact-e2e-'))
    await mkdir(join(e2e, 'docs/agents'), { recursive: true })
    await writeFile(join(e2e, 'docs/agents/okr.toml'), '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 95"\nmeasure = "cat k.txt"\n')
    execFileSync('git', ['-C', e2e, 'init', '-q'])
    execFileSync('git', ['-C', e2e, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'e2e'])
    execFileSync('git', ['-C', e2e, 'add', '.'])
    execFileSync('git', ['-C', e2e, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'okr'])
    await writeFile(join(dir, 'repos.json'), JSON.stringify({ nawaban: repo, e2e }))
  })

  it('judges a declaration registered as its ticket was claimed by the first round after its result', async () => {
    await measure(80, 10)
    const id = await newTask('e2e', 'E2E-01')
    expect((await claimRegisteringAsTheCliDoes('E2E-01', '--o', 'O', '--kr', 'K=toward')).code).toBe(0)
    expect((await team.thread(id)).replies.at(-1)!.blocks[0]!.data).toMatchObject({ krs: [{ name: 'K', heading: 'toward', reading: '80' }] })
    expect((await close('E2E-01', '--kr', 'K=85 实测')).code).toBe(0)
    await measure(85, 11)
    expect(await verdicts()).toEqual([{ ticket: 'E2E-01', declared: 'toward', verdict: '符合' }])
  })

  it('closes a ticket registered after its first pull request, and gives it no verdict', async () => {
    await measure(85, 12)
    const id = await newTask('e2e', 'E2E-02')
    await nawaban('event', id, '--kind', 'link', '--body', 'pr:https://example.test/pull/1')
    await nawaban('event', id, '--kind', 'impact', '--o', 'O', '--kr', 'K=toward')
    expect((await close('E2E-02', '--kr', 'K=90 实测')).code).toBe(0)
    await measure(90, 13)
    expect(await verdicts()).toEqual([])
  })
})
