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
import { INBOX_OPEN, inboxChannel, inboxItemText } from '../src/page.ts'

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

function nawaban(argv: string[], { input = '', more = {}, cwd }: { input?: string; more?: Record<string, string>; cwd?: string } = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile('node', [CLI, ...argv], { env: { ...env, ...more }, cwd }, (error, out, err) => resolve({ code: error ? Number(error.code) : 0, out, err }))
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
  expect(verbsListedIn((await succeeds('help', 'more')).out)).toEqual(['okr-stat', 'tell', 'block', 'web', 'serve', 'import', 'hook', 'json', 'board'])
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
  expect((await succeeds('list', '--project', 'p1')).out).toMatch(/^C1 +claimed +一张票$/m)
  expect((await succeeds('status', '--project', 'p1')).out).toContain('C1 一张票')
  await succeeds('close', 'C1', '--done')
  expect((await succeeds('show', 'C1')).out).toContain('completed')
})

it('takes the project of the repository it runs in for create and status, and still lists every project', EVERY_STEP_STARTS_A_NODE, async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'nawaban-cli-home-')))
  const repo = join(tmp, 'repo')
  const outside = join(tmp, 'outside')
  const homeBoard = join(tmp, 'board')
  for (const dir of [repo, outside, homeBoard]) await mkdir(dir)
  await new Promise((resolve, reject) => execFile('git', ['init', '-q', repo], (error) => (error ? reject(error) : resolve(null))))
  await writeFile(join(homeBoard, 'repos.json'), JSON.stringify({ 'p-home': repo }))
  const at = (cwd: string) => ({ cwd, more: { NAWABAN_BOARD_DIR: homeBoard } })
  expect((await nawaban(['create', 'H-IN', '--title', '在仓库里建'], at(repo))).code).toBe(0)
  expect((await succeeds('show', 'H-IN')).out).toContain('project     p-home')
  await succeeds('create', 'H-ELSE', '--title', '别的项目', '--project', 'p-else')
  const refused = await nawaban(['create', 'H-OUT', '--title', '不在仓库里'], at(outside))
  expect(refused.code).toBe(2)
  expect(refused.err).toContain('加 --project')
  const inRepo = await nawaban(['status'], at(repo))
  expect(inRepo.out).toMatch(/^p-home 进行中的事/)
  expect(inRepo.out).toContain('H-IN 在仓库里建')
  expect(inRepo.out).not.toContain('H-ELSE')
  const elsewhere = await nawaban(['status'], at(outside))
  expect(elsewhere.out).toMatch(/^看板 进行中的事/)
  expect(elsewhere.out).toContain('H-ELSE 别的项目')
  const listed = JSON.parse((await nawaban(['list', '--json'], at(repo))).out) as { tasks: { channel: string }[] }
  expect(listed.tasks.map((t) => t.channel)).toEqual(expect.arrayContaining(['p-home', 'p-else']))
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

it('prints every event of a ticket under show --all, and only the latest without it', EVERY_STEP_STARTS_A_NODE, async () => {
  await succeeds('create', 'A1', '--title', '事件多', '--project', 'p-all')
  for (const n of [1, 2, 3]) await succeeds('event', 'A1', 'note', `第 ${n} 条\n第二行 ${n}`)
  const brief = (await succeeds('show', 'A1')).out
  expect(brief).toContain('第 3 条')
  expect(brief).not.toContain('第 1 条')
  const every = (await succeeds('show', 'A1', '--all')).out
  expect(every).toMatch(/events {6}3\n/)
  expect(every.indexOf('第 1 条')).toBeLessThan(every.indexOf('第 2 条'))
  expect(every).toContain('    第二行 3')
  expect((JSON.parse((await succeeds('show', 'A1', '--all', '--json')).out) as { events: unknown[] }).events).toHaveLength(3)
})

it('turns an inbox item into a ticket in its project and marks it done, once', EVERY_STEP_STARTS_A_NODE, async () => {
  const item = await team.post(inboxChannel('p-inbox'), { text: inboxItemText('面板加夜间模式'), labels: INBOX_OPEN })
  const made = await succeeds('create', 'IN-1', '--title', '夜间模式', '--inbox', item.id)
  expect(made.out).toBe(`✓ 建票 IN-1：夜间模式（收件箱 ${item.id} 已处理）\n`)
  const shown = (await succeeds('show', 'IN-1')).out
  expect(shown).toContain('project     p-inbox')
  expect(shown).toContain('面板加夜间模式')
  expect((await team.thread(item.id)).message.labels).toMatchObject({ inbox: 'done', task: 'IN-1' })
  const again = await nawaban(['create', 'IN-2', '--title', '再转一次', '--inbox', item.id])
  expect([again.code, again.err]).toEqual([1, expect.stringContaining(`收件箱里没有开着的条目 ${item.id}`)])
  expect((await nawaban(['show', 'IN-2'])).code).toBe(1)

  const another = await team.post(inboxChannel('p-inbox'), { text: inboxItemText('导出 CSV'), labels: INBOX_OPEN })
  const intoAnOldTicket = await nawaban(['create', 'IN-1', '--title', '导出', '--inbox', another.id])
  expect([intoAnOldTicket.code, intoAnOldTicket.err]).toEqual([1, expect.stringContaining('已经有票 IN-1')])
  expect((await team.thread(another.id)).message.labels).toMatchObject({ inbox: 'open' })
  expect((await succeeds('show', 'IN-1')).out).not.toContain('导出 CSV')
})

it('refuses to reopen a ticket closed done or cancelled, so a mistaken close takes a new ticket', EVERY_STEP_STARTS_A_NODE, async () => {
  for (const [key, how] of [['RO-1', '--done'], ['RO-2', '--cancelled']] as const) {
    await succeeds('create', key, '--title', '关错了', '--project', 'p-reopen')
    await succeeds('claim', key)
    await succeeds('close', key, how)
    const { task } = JSON.parse((await succeeds('show', key, '--json')).out) as { task: { id: string } }
    const reopen = await nawaban(['board', 'tasks', 'reopen', task.id])
    expect(reopen.code).not.toBe(0)
    expect(reopen.out + reopen.err).toMatch(/Can't reopen task #\d+\. It's finished\./)
    await succeeds('create', `${key}-AGAIN`, '--title', '关错了，重开', '--project', 'p-reopen')
    await succeeds('event', key, 'note', `重开为 ${key}-AGAIN`)
    expect((await succeeds('show', key)).out).toContain(`重开为 ${key}-AGAIN`)
  }
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
  const file = join(boardDir, 'body.md')
  await writeFile(file, '- 已完成：从文件经标准输入\n')
  const viaFile = await nawaban(['event', 'E2', 'note', '--body-file', file, '--as', 'cc-aaaa1111'])
  expect(viaFile.code).toBe(2)
  const hint = /改用：nawaban (.+)$/m.exec(viaFile.err)?.[1]
  expect(hint).toBe(`event E2 note - --as cc-aaaa1111 < ${file}`)
  expect((await nawabanAsTheShellRunsIt(hint!)).code).toBe(0)
  expect((await repliesOf('E2')).at(-1)).toBe('- 已完成：从文件经标准输入')
})

it('waits out a board that is restarting, so a verb run meanwhile still lands', EVERY_STEP_STARTS_A_NODE, async () => {
  const probe = await listen(() => Promise.resolve(new Response()), 0)
  const port = (probe.address() as AddressInfo).port
  await new Promise((closed) => probe.close(closed))
  const restarting = nawaban(['create', 'R1', '--title', '重启时建的票', '--project', 'p5'], { more: { BOARD_URL: `http://127.0.0.1:${port}/api/board` } })
  await new Promise((wake) => setTimeout(wake, 1200))
  const back = await listen((request) => team.fetch(request), port)
  const r = await restarting
  back.close()
  expect([r.code, r.err]).toEqual([0, ''])
  expect((await succeeds('show', 'R1')).out).toContain('重启时建的票')
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
