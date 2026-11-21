import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const HOOKS = join(ROOT, 'hooks')
const CLI = join(ROOT, 'board/src/cli.ts')
const SECRET = 'test-secret'
const SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const AS = 'cc-aaaa1111'
const sh = promisify(execFile)
const SLOW = { timeout: 60_000 }
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let env: Record<string, string> = {}
let repo = ''
let tmp = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  tmp = await mkdtemp(join(tmpdir(), 'nawaban-hooks-'))

  await mkdir(join(tmp, 'bin'))
  await writeFile(join(tmp, 'bin/hc'), '#!/bin/sh\necho "{\\"labels\\":{\\"role\\":\\"$ROLE\\"}}"\n')
  await writeFile(join(tmp, 'bin/gh'), `#!/bin/sh\necho "$@" >> ${tmp}/gh.log\necho gh down >&2\nexit 1\n`)
  await Promise.all(['hc', 'gh'].map((b) => chmod(join(tmp, 'bin', b), 0o755)))
  repo = join(tmp, 'proj')
  await mkdir(join(repo, 'docs/agents'), { recursive: true })
  await writeFile(join(repo, 'docs/agents/orchestrator.md'), '规矩正文\n')
  await writeFile(join(repo, 'docs/agents/okr.toml'), '')
  await sh('git', ['init', '-q', '-b', 'main', repo])

  await mkdir(join(tmp, 'board'))
  await writeFile(join(tmp, 'board/repos.json'), JSON.stringify({ proj: repo }))
  env = {
    PATH: `${join(tmp, 'bin')}:${process.env.PATH}`,
    HOME: tmp,
    BOARD_URL: url,
    BOARD_TOKEN: SECRET,
    NAWABAN_BOARD_DIR: join(tmp, 'board'),
    XDG_CONFIG_HOME: join(tmp, 'config'),
    CLAUDE_CODE_SESSION_ID: SESSION,
    HC_TERMINAL_ID: 't1',
    CLAUDE_PROJECT_DIR: repo,
    NAWABAN_CLI: 'board',
    ROLE: 'orchestrator',
  }
})
afterAll(() => server.close())

async function spawn(what: string[], input = '', more: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile(what[0]!, what.slice(1), { cwd: repo, env: { ...env, ...more } }, (error, out, err) =>
      resolve({ code: error ? Number(error.code) : 0, out, err }),
    )
    child.stdin!.end(input)
  })
}
const nawaban = async (...argv: string[]) => {
  const r = await spawn(['node', CLI, ...argv])
  expect(r.code, `${argv.join(' ')}: ${r.err}`).toBe(0)
  return r.out
}
const hook = (name: string, input: unknown = '', more: Record<string, string> = {}) =>
  spawn(['sh', join(HOOKS, name)], typeof input === 'string' ? input : JSON.stringify(input), more)
const inbox = async (session: string, more: Record<string, string> = {}) => {
  const r = await hook('inbox.sh', { session_id: session, cwd: repo, stop_hook_active: false }, more)
  expect(r.code).toBe(0)
  return r.out.trim() ? (JSON.parse(r.out).systemMessage as string) : null
}
const idOf = async (key: string) => (await team.tasks.list({ state: 'all', label: { key } })).tasks[0]!.message.id

it('routes a project as the panel does: the old CLI unless it moved to the board', SLOW, async () => {
  const route = (dir: string, more: Record<string, string> = {}) => spawn(['node', join(HOOKS, 'route.mjs'), dir], '', more)

  expect((await route(repo, { NAWABAN_CLI: '' })).out).toBe('old\n')
  expect((await route(repo)).out).toBe('board proj\n')
  expect((await route(join(repo, 'docs/agents'))).out).toBe('board proj\n')
  expect((await route(tmp)).out).toBe('old\n')
})

it('prints the index off the board when an orchestrator window starts, and nothing in any other window', SLOW, async () => {
  await nawaban('create', 'K1', '--title', '要密钥', '--project', 'proj')
  await nawaban('create', 'K2', '--title', '在干的', '--project', 'proj')
  await nawaban('claim', 'K2')
  await nawaban('event', await idOf('K2'), '--kind', 'note', '--body', '写完测试，下一步：接 CLI。', '--as', AS)
  const start = await hook('leader-index.sh')
  expect(start.code, start.err).toBe(0)
  expect(start.out).toContain('proj 进行中的事')
  expect(start.out).toContain('在推 1 · 没动 1')
  expect(start.out).toContain('## 在推\n- K2 在干的\n  进展 0 分钟前：写完测试\n  下一步：接 CLI')
  expect(start.out).toContain('- K1 要密钥')
  expect(start.out).toContain('规矩正文')
  expect((await hook('leader-index.sh', '', { ROLE: 'worker' })).out).toBe('')
})

it('shows what waits on the decision-maker under each reply, new items first, then that nothing changed', SLOW, async () => {
  expect(await inbox('s1')).toBe('待你决定 0 件')
  expect(await inbox('s1')).toBeNull()
  await nawaban('claim', 'K1')
  await nawaban('event', await idOf('K1'), '--kind', 'note', '--body', 'triage: needs-info — 等你：给密钥', '--as', AS)

  await nawaban('create', 'O1', '--title', '别的项目', '--project', 'other')
  await nawaban('claim', 'O1')
  await nawaban('event', await idOf('O1'), '--kind', 'note', '--body', 'triage: needs-info — 等你：别处', '--as', AS)

  const first = await inbox('s1')
  expect(first).toBe('待你决定 1 件：K1 要密钥｜说「同步」看卡')
  expect(await inbox('s1')).toBe('待你决定 1 件（无变化）')
  expect(await inbox('s1', { ROLE: 'worker' })).toBeNull()

  const card = ['--kind', 'ask', '--body', '发不发', '--kr', 'K', '--context', '事实', '--option', '发｜快｜two-way', '--option', '不发｜稳｜two-way', '--rec', '发']
  await nawaban('event', await idOf('K2'), ...card, '--as', AS)
  expect(await inbox('s1')).toBe('待你决定 2 件：K2 在干的｜说「同步」看卡')
  expect(await inbox('s2')).toMatch(/^待你决定 2 件：K\d .* · K\d /)

  await nawaban('event', await idOf('K1'), '--kind', 'note', '--body', 'triage: ready-for-agent')
  await nawaban('event', await idOf('K2'), '--kind', 'resolve', '--body', '发')
  expect(await inbox('s1')).toBe('待你决定 0 件')
  expect(await inbox('s1')).toBeNull()
})

it('stays silent when the board is down', SLOW, async () => {
  expect(await inbox('s1', { BOARD_URL: 'http://127.0.0.1:9/api/board' })).toBeNull()
})

it('runs one impact guard per repository: the board\'s where the project moved, the old one elsewhere', SLOW, async () => {
  const call = (command: string) => ({ cwd: repo, tool_input: { command } })
  const close = call('vb tasks complete 5')
  const merge = call('gh pr merge 7')
  const log = () => readFile(join(tmp, 'gh.log'), 'utf8').catch(() => '')

  const boardClose = await hook('board-impact-guard.sh', close)
  expect([boardClose.code, boardClose.err]).toEqual([2, expect.stringContaining('nawaban close')])
  expect((await hook('impact-guard.sh', merge)).code).toBe(0)
  expect(await log()).toBe('')

  const tabbed = await hook('board-impact-guard.sh', call('gh pr\tmerge 7'))
  expect([tabbed.code, tabbed.err]).toEqual([2, expect.stringContaining('核不了 KR 影响声明')])

  const old = { NAWABAN_CLI: 'old' }
  expect((await hook('board-impact-guard.sh', close, old)).code).toBe(0)
  const oldMerge = await hook('impact-guard.sh', merge, old)
  expect([oldMerge.code, oldMerge.err]).toEqual([2, expect.stringContaining('核不了 KR 影响声明')])
  expect(await log()).toContain('pr view 7')
})

it('registers the renewal on every prompt and tool call, and both impact guards before Bash', SLOW, async () => {
  const { hooks } = JSON.parse(await readFile(join(HOOKS, 'hooks.json'), 'utf8'))
  const names = (event: string) => hooks[event].flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command.split('/').pop()!.replace('"', '')))
  expect(names('UserPromptSubmit')).toContain('renew.sh')
  expect(names('PostToolUse')).toContain('renew.sh')
  expect(names('PreToolUse')).toEqual(expect.arrayContaining(['impact-guard.sh', 'board-impact-guard.sh']))
})
