import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'
import { projectsData } from '../src/views.ts'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const SECRET = 'test-secret'
const SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const NOTHING_LISTENS_HERE = 'http://127.0.0.1:9/api/board'
const HELP_LINES_AT_MOST = 24
const HELP_COLUMNS_AT_MOST = 80
const TEN_VERBS = ['status', 'show', 'list', 'okr', 'create', 'claim', 'event', 'close', 'dispatch', 'merge']
const EVERY_STEP_STARTS_A_NODE = { timeout: 60_000 }
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let env: Record<string, string> = {}
let boardDir = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  const tmp = await mkdtemp(join(tmpdir(), 'nawaban-cli-'))
  boardDir = join(tmp, 'board')
  await mkdir(boardDir)
  env = {
    PATH: process.env.PATH!,
    HOME: tmp,
    BOARD_URL: url,
    BOARD_TOKEN: SECRET,
    NAWABAN_BOARD_DIR: boardDir,
    XDG_CONFIG_HOME: join(tmp, 'config'),
    CLAUDE_CODE_SESSION_ID: SESSION,
    HC_TERMINAL_ID: '',
  }
})
afterAll(() => server.close())

function nawaban(argv: string[], { input = '', more = {} }: { input?: string; more?: Record<string, string> } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile('node', [CLI, ...argv], { env: { ...env, ...more } }, (error, out, err) => resolve({ code: error ? Number(error.code) : 0, out, err }))
    child.stdin!.end(input)
  })
}
const succeeds = async (...argv: string[]) => {
  const r = await nawaban(argv)
  expect(r.code, `${argv.join(' ')}: ${r.err}`).toBe(0)
  return r
}
const columnsCountingWideCharactersAsTwo = (line: string) => [...line].reduce((n, c) => n + (/[\p{Script=Han}\u3000-\u303f\uff00-\uff60]/u.test(c) ? 2 : 1), 0)
const verbsListedIn = (help: string) => [...help.matchAll(/^ {2}(\S+)/gm)].map((m) => m[1]!)
const hintedCommand = (err: string) => /^改用：nawaban (.+)$/m.exec(err)?.[1]

it('fits the help on one screen and lists the ten everyday verbs', async () => {
  const { out } = await succeeds('--help')
  const lines = out.trimEnd().split('\n')
  expect(lines.length).toBeLessThanOrEqual(HELP_LINES_AT_MOST)
  expect(lines.filter((line) => columnsCountingWideCharactersAsTwo(line) > HELP_COLUMNS_AT_MOST)).toEqual([])
  expect(verbsListedIn(out)).toEqual(TEN_VERBS)
  for (const same of [[], ['-h'], ['help']]) expect((await succeeds(...same)).out).toBe(out)
  expect(verbsListedIn((await succeeds('help', 'more')).out)).toEqual(['block', 'web', 'serve', 'import', 'hook', 'json', 'inbox', 'page', 'board'])
})

it("answers every verb's --help without reaching a board", EVERY_STEP_STARTS_A_NODE, async () => {
  const listed = [...verbsListedIn((await succeeds('--help')).out), ...verbsListedIn((await succeeds('help', 'more')).out)]
  const ownHelp = await Promise.all(listed.filter((verb) => verb !== 'board').map(async (verb) => [verb, await nawaban([verb, '--help'], { more: { BOARD_URL: NOTHING_LISTENS_HERE } })] as const))
  for (const [verb, r] of ownHelp) expect([verb, r.code, r.out.split('\n')[0]]).toEqual([verb, 0, expect.stringMatching(new RegExp(`^用法：nawaban ${verb}`))])
  expect((await nawaban(['show', 'X', '-h'], { more: { BOARD_URL: NOTHING_LISTENS_HERE } })).out).toMatch(/^用法：nawaban show/)
  const upstreamHelp = await nawaban(['board'], { more: { BOARD_URL: NOTHING_LISTENS_HERE } })
  expect([upstreamHelp.code, upstreamHelp.out]).toEqual([0, expect.stringContaining('usage: nawaban board <command>')])
  const aValueNamedHelpIsNoHelpRequest = await nawaban(['create', 'H1', '--title', '--help'], { more: { BOARD_URL: NOTHING_LISTENS_HERE } })
  expect(aValueNamedHelpIsNoHelpRequest.code).not.toBe(0)
  expect(aValueNamedHelpIsNoHelpRequest.out).toBe('')
})

it('runs each everyday verb that needs only the board on a fresh board', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'C1', '--title', '一张票', '--project', 'p1')
  await succeeds('claim', 'C1')
  await succeeds('event', 'C1', '--kind', 'note', '--body', '已完成：建票')
  expect((await succeeds('show', 'C1')).out).toContain('已完成：建票')
  expect((await succeeds('list', '--project', 'p1')).out).toContain('C1  一张票')
  expect((await succeeds('status', '--project', 'p1')).out).toContain('C1 一张票')
  await succeeds('close', 'C1', '--done')
  expect((await succeeds('show', 'C1')).out).toContain('completed')
})

it('prints under status what index printed, and points index at status', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'S1', '--title', '没人动的', '--project', 'p2')
  const status = await succeeds('status', '--project', 'p2')
  const index = await succeeds('index', '--project', 'p2')
  expect(index.out).toBe(status.out)
  expect(status.err).toBe('')
  expect(hintedCommand(index.err)).toBe('status --project p2')
})

it('keeps the JSON the panel reads', async () => {
  await writeFile(join(boardDir, 'local.db'), '')
  expect((await succeeds('json', 'db')).out).toBe(JSON.stringify({ db: await realpath(join(boardDir, 'local.db')) }) + '\n')
  expect(JSON.parse((await succeeds('json', 'projects')).out)).toEqual(JSON.parse(JSON.stringify(await projectsData(team))))
})

it('refuses closing a task with the upstream verb through hook guard, as guard did', EVERY_STEP_STARTS_A_NODE, async () => {
  const input = JSON.stringify({ cwd: boardDir, tool_input: { command: 'nawaban board tasks complete 12' } })
  const hook = await nawaban(['hook', 'guard'], { input })
  expect([hook.code, hook.err]).toEqual([2, expect.stringContaining('nawaban close')])
  const old = await nawaban(['guard'], { input })
  expect([old.code, hintedCommand(old.err)]).toEqual([2, 'hook guard'])
  expect((await nawaban(['hook', 'guard'], { input: JSON.stringify({ cwd: boardDir, tool_input: { command: 'nawaban close X --done' } }) })).code).toBe(0)
})

it("runs an upstream verb typed bare, and names the board form that runs it too", EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'U1', '--title', '读它', '--project', 'p3')
  const id = (await team.tasks.list({ state: 'all', label: { key: 'U1' } })).tasks[0]!.message.id
  const bare = await succeeds('read', id)
  expect(bare.out).toContain('读它')
  expect(hintedCommand(bare.err)).toBe(`board read ${id}`)
  const viaBoard = await succeeds(...hintedCommand(bare.err)!.split(' '))
  expect([viaBoard.out, viaBoard.err]).toEqual([expect.stringContaining('读它'), ''])
  const quoted = await succeeds('reply', id, '两个 词')
  expect(hintedCommand(quoted.err)).toBe(`board reply ${id} '两个 词'`)
})
