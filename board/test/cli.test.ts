import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
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
const MINUTES_A_ONE_HOUR_RENEWAL_ADDS_PAST_A_TEN_MINUTE_LEASE = 40
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let env: Record<string, string> = {}
let boardDir = ''
let shimDir = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  const tmp = await mkdtemp(join(tmpdir(), 'nawaban-cli-'))
  boardDir = join(tmp, 'board')
  await mkdir(boardDir)
  shimDir = join(tmp, 'bin')
  await mkdir(shimDir)
  await writeFile(join(shimDir, 'nawaban'), `#!/bin/sh\nexec node ${CLI} "$@"\n`)
  await chmod(join(shimDir, 'nawaban'), 0o755)
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
function nawabanAsTheShellRunsIt(commandLine: string) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile('sh', ['-c', `nawaban ${commandLine}`], { env: { ...env, PATH: `${shimDir}:${env.PATH}` } }, (error, out, err) =>
      resolve({ code: error ? Number(error.code) : 0, out, err }),
    )
    child.stdin!.end()
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
const wholeHintedCommand = (err: string) => /^改用：nawaban ([\s\S]+)\n$/.exec(err)?.[1]

it('fits the help on one screen and lists the ten everyday verbs', EVERY_STEP_STARTS_A_NODE, async () => {
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
  for (const verb of listed.filter((v) => v !== 'board')) {
    const r = await nawaban([verb, '--help'], { more: { BOARD_URL: NOTHING_LISTENS_HERE } })
    expect([verb, r.code, r.out.split('\n')[0]]).toEqual([verb, 0, expect.stringMatching(new RegExp(`^用法：nawaban ${verb}`))])
  }
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
  await succeeds('event', 'C1', 'note', '已完成：建票')
  expect((await succeeds('show', 'C1')).out).toContain('已完成：建票')
  expect((await succeeds('list', '--project', 'p1')).out).toContain('C1  一张票')
  expect((await succeeds('status', '--project', 'p1')).out).toContain('C1 一张票')
  await succeeds('close', 'C1', '--done')
  expect((await succeeds('show', 'C1')).out).toContain('completed')
})

it('says there is no such verb, lists the ten, and leaves the board alone', async () => {
  for (const word of ['bogus', 'toString', '--as']) {
    const r = await nawaban([word, 'x'])
    expect(r.code).toBe(2)
    expect(r.err).toContain(`✗ 没有动词 ${word}`)
    expect(verbsListedIn(r.err)).toEqual(TEN_VERBS)
  }
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

it('renews through hook renew a claim made through board, as dispatch makes it for a worker', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'W1', '--title', '替 worker 认领', '--project', 'p4')
  const id = (await team.tasks.list({ state: 'all', label: { key: 'W1' } })).tasks[0]!.message.id
  const until = async () => Date.parse((await team.thread(id, { limit: 1 })).message.task!.claim!.until)
  await succeeds('board', 'tasks', 'claim', id, '--as', 'cc-aaaa1111', '--lease', '10m', '--json')
  const claimedUntil = await until()
  const renewed = await nawaban(['hook', 'renew', '--session', SESSION])
  expect([renewed.code, renewed.err]).toEqual([0, ''])
  expect((await until()) - claimedUntil).toBeGreaterThan(MINUTES_A_ONE_HOUR_RENEWAL_ADDS_PAST_A_TEN_MINUTE_LEASE * 60_000)
})

const boardIdOf = async (key: string) => (await team.tasks.list({ state: 'all', label: { key } })).tasks[0]!.message.id
const repliesOf = async (key: string) => (await team.thread(await boardIdOf(key))).replies.map((r) => r.blocks.map((b) => `${b.schema}@${b.version}`).join() || r.text)
const ASK_CARD = ['--kr', 'O1 / KR1', '--context', '测试都过', '--option', '发｜快｜双向门', '--option', '等｜稳｜双向门', '--rec', '发']

it('records each of the six kinds written as event <票> <类> [正文]', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'E1', '--title', '六类', '--project', 'p5')
  for (const argv of [
    ['note', '已完成：一'],
    ['decision', '决定：sqlite\n背景：用哪个库\n否决方案：pg — 太重'],
    ['link', 'pr:https://github.com/acme/web/pull/1'],
    ['impact', '--o', '无'],
    ['ask', '发不发？', ...ASK_CARD],
    ['resolve', '发'],
  ]) {
    const r = await succeeds('event', 'E1', ...argv)
    expect(r.err, argv[0]).toBe('')
  }
  expect(await repliesOf('E1')).toEqual(['已完成：一', 'nawaban-decision@1', 'nawaban-link@1', 'nawaban-impact@2', 'nawaban-ask@1', 'nawaban-resolve@1'])
})

it('reads the body from stdin on -, and after --, a body starting with - included', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'E2', '--title', '正文从哪来', '--project', 'p5')
  const fromStdin = await nawaban(['event', 'E2', 'note', '-'], { input: '- 已完成：从标准输入\n' })
  expect([fromStdin.code, fromStdin.err]).toEqual([0, ''])
  await succeeds('event', 'E2', 'note', '--', '- 已完成：在 -- 之后')
  expect(await repliesOf('E2')).toEqual(['- 已完成：从标准输入', '- 已完成：在 -- 之后'])
  expect((await nawaban(['event', 'E2', 'note', '--body-file', join(boardDir, 'body.md')])).code).toBe(2)
})

it('puts a positional body into the task create makes, and reads - from stdin there too', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'E3', '--title', '有正文', '--project', 'p5', '正文写在位置上')
  expect((await succeeds('show', 'E3')).out).toContain('正文写在位置上')
  expect((await nawaban(['create', 'E4', '--title', '从标准输入', '--project', 'p5', '-'], { input: '- 第一条\n' })).code).toBe(0)
  expect((await succeeds('show', 'E4')).out).toContain('- 第一条')
  const file = join(boardDir, 'create-body.md')
  await writeFile(file, '## What to build\n从文件读的正文\n')
  await succeeds('create', 'E11', '--title', '从文件', '--project', 'p5', '--body-file', file)
  expect((await succeeds('show', 'E11')).out).toContain('从文件读的正文')
})

it('runs the old --kind and --body, names the new form, and that form runs with no hint', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'E5', '--title', '旧写法', '--project', 'p5')
  for (const old of [
    ['event', 'E5', '--kind', 'note', '--body', '两个 词', '--as', 'cc-aaaa1111'],
    ['event', 'E5', '--kind', 'link', '--body', 'pr:https://github.com/acme/web/pull/2'],
    ['event', 'E5', '--kind', 'decision', '--by', 'user', '--body', "决定：it's\n背景：q\n否决方案：r"],
    ['event', 'E5', '--kind=note', '--body=- 以减号开头'],
    ['create', 'E6', '--title', '旧建票', '--body', '旧的正文', '--project', 'p5'],
  ]) {
    const r = await succeeds(...old)
    const hint = wholeHintedCommand(r.err)
    expect(hint, old.join(' ')).toBeDefined()
    const again = await nawabanAsTheShellRunsIt(hint!)
    expect([again.code, again.err], hint).toEqual([0, ''])
  }
  expect(await repliesOf('E5')).toEqual([
    '两个 词', '两个 词', 'nawaban-link@1', 'nawaban-link@1', 'nawaban-decision@1', 'nawaban-decision@1', '- 以减号开头', '- 以减号开头',
  ])
  expect(hintedCommand((await succeeds('event', 'E5', '--kind', 'note', '--body', 'x')).err)).toBe('event E5 note x')
})

it('refuses the same thing given twice and differently, as a usage error', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'E7', '--title', '冲突', '--project', 'p5')
  for (const [argv, named] of [
    [['event', 'E7', 'note', 'x', '--kind', 'decision'], '--kind decision'],
    [['event', 'E7', 'note', 'x', '--body', 'y'], '--body'],
    [['create', 'E8', '--title', 't', '--project', 'p5', 'x', '--body', 'y'], '--body'],
  ] as const) {
    const r = await nawaban([...argv])
    expect([r.code, r.err], argv.join(' ')).toEqual([2, expect.stringContaining(named)])
  }
  expect(await repliesOf('E7')).toEqual([])
})

it('refuses an ask with no --option, naming what it lacks', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'E9', '--title', '缺选项', '--project', 'p5')
  const r = await nawaban(['event', 'E9', 'ask', '发不发？', '--kr', 'K', '--context', 'c', '--rec', '发'])
  expect([r.code, r.err]).toEqual([1, expect.stringContaining('备选方案 (--option')])
  expect(await repliesOf('E9')).toEqual([])
})

it('takes --question, --verdict and --rejected no more', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'E10', '--title', '删掉的 flag', '--project', 'p5')
  for (const flag of ['--question', '--verdict', '--rejected']) {
    expect((await nawaban(['event', 'E10', 'decision', flag, 'x'])).code, flag).toBe(2)
  }
  expect(await repliesOf('E10')).toEqual([])
})
