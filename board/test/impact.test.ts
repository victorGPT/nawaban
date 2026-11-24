import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createApp } from '@vercel/board/cli'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'
import { event } from '../src/events.ts'
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

it('takes an impact whose names are in the okr.toml', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=↑ 3→5 实测', '--kr', 'KR2==')).code).toBe(0)
  const { replies } = await team.thread(id)
  expect(replies[0]!.blocks[0]!.data).toEqual({ objective: 'O1', krs: [{ name: 'KR1', dir: '↑', before: '3', after: '5', basis: '实测' }, { name: 'KR2', dir: '=' }] })
})

it('keeps the values an = declaration expects to hold', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1== 83.3→83.3 预计')).code).toBe(0)
  const { replies } = await team.thread(id)
  expect(replies[0]!.blocks[0]!.data).toEqual({ objective: 'O1', krs: [{ name: 'KR1', dir: '=', before: '83.3', after: '83.3', basis: '预计' }] })
})

it('refuses a KR or an O the okr.toml does not have', async () => {
  const id = await newTask()
  const kr = await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR9=↑ 3→5 实测')
  expect(kr.code).toBe(1)
  expect(kr.dropped).toBe('O1 下没有这个 KR:KR9(有:KR1、KR2)')
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O9')).dropped).toMatch(/没有这个 O:O9/)
  expect(await replies(id)).toBe(0)
})

it("holds the board's own writers to the names, not only nawaban event", async () => {
  const id = await newTask()
  const wrong = { objective: 'O1', krs: [{ name: 'KR9', dir: '=' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-impact@1', JSON.stringify(wrong))).dropped).toMatch(/没有这个 KR:KR9/)
  const bare = { objective: 'O1', krs: [{ name: 'KR1', dir: '↑' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-impact@1', JSON.stringify(bare))).failure?.data?.error?.code).toBe('invalid_block')
  expect(await replies(id)).toBe(0)
})

it('refuses ↑ or ↓ without numbers before and after', async () => {
  const id = await newTask()
  const bare = await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=↑')
  expect(bare.code).toBe(1)
  expect(bare.err).toMatch(/krs\[0\]\.before is missing/)
  expect((await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1=↓ 3→5')).code).toBe(2)
  const words = { objective: 'O1', krs: [{ name: 'KR1', dir: '↑', before: 'low', after: 'high', basis: '预计' }] }
  expect((await nawaban('reply', id, '--schema', 'nawaban-impact@1', JSON.stringify(words))).dropped).toMatch(/前后值要是数字/)
  expect(await replies(id)).toBe(0)
})

it('lets --o 无 through, with no KR, in any project', async () => {
  const id = await newTask()
  expect((await nawaban('event', id, '--kind', 'impact', '--o', '无')).code).toBe(0)
  expect((await nawaban('event', id, '--kind', 'impact', '--o', '无', '--kr', 'KR1==')).dropped).toBe('--o 无 不带 --kr')
  const plain = await newTask('plain')
  expect((await nawaban('event', plain, '--kind', 'impact', '--o', '无')).code).toBe(0)
  expect((await nawaban('event', plain, '--kind', 'impact', '--o', 'O1')).dropped).toMatch(/没有 docs\/agents\/okr.toml/)
})

it('refuses to close as done a task with no impact, where the project keeps an okr.toml', async () => {
  const close = async (key: string) => {
    for (const [k, v] of Object.entries({ BOARD_URL: url, BOARD_TOKEN: SECRET, NAWABAN_BOARD_DIR: dir, CLAUDE_CODE_SESSION_ID: 'aaaa1111-0', HC_TERMINAL_ID: '' })) vi.stubEnv(k, v)
    let err = ''
    const quiet = [vi.spyOn(process.stdout, 'write').mockImplementation(() => true), vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true))]
    try {
      return { code: await run(['close', key, '--done']), err }
    } finally {
      for (const spy of quiet) spy.mockRestore()
      vi.unstubAllEnvs()
    }
  }
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
  const pr = { number: 7, title: 'feat: x', body: 'NAWABAN-T-01', headRefName: 'feat/x' }
  const refused = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7 --squash', worktree, pr)
  expect(refused.code).toBe(2)
  expect(refused.err).toMatch(/NAWABAN-T-01/)

  await nawaban('event', id, '--kind', 'impact', '--o', 'O1', '--kr', 'KR1==')
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7 --squash', worktree, pr)).code).toBe(0)
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7', worktree, { ...pr, body: 'no key' })).code).toBe(2)
  expect((await preToolUseHookOnBashAsClaudeCodeRunsIt('echo "gh pr merge 7"', worktree, pr)).code).toBe(0)

  await (await team.tasks.claim(id)).complete('done')
  const doneStillHasItsDeclaration = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh pr merge 7 --squash', worktree, pr)
  expect(doneStillHasItsDeclaration.code).toBe(0)
})

it("reads gh's -R before pr merge as a merge", EVERY_HOOK_RUN_STARTS_A_SHELL_AND_TWO_NODES, async () => {
  await newTask('nawaban', 'NAWABAN-T-02')
  const pr = { number: 8, title: 'NAWABAN-T-02', body: '', headRefName: 'x' }
  const refused = await preToolUseHookOnBashAsClaudeCodeRunsIt('gh -R acme/web pr merge 8 --squash', worktree, pr)
  expect(refused.code).toBe(2)
  expect(refused.err).toMatch(/NAWABAN-T-02/)
})
