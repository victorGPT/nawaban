import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'
import { stable } from './stable.ts'

const CLI = new URL('../src/cli.ts', import.meta.url).pathname
const SECRET = 'test-secret'
const A_SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const B_SESSION = 'bbbb2222-0000-0000-0000-000000000000'
const EVERY_STEP_STARTS_A_NODE = { timeout: 60_000 }
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let env: Record<string, string> = {}
let outside = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  const tmp = await mkdtemp(join(tmpdir(), 'nawaban-output-'))
  outside = join(tmp, 'outside')
  await mkdir(join(tmp, 'board'))
  await mkdir(outside)
  env = {
    PATH: process.env.PATH!,
    HOME: tmp,
    BOARD_URL: url,
    BOARD_TOKEN: SECRET,
    NAWABAN_BOARD_DIR: join(tmp, 'board'),
    XDG_CONFIG_HOME: join(tmp, 'config'),
    CLAUDE_CODE_SESSION_ID: A_SESSION,
    HC_TERMINAL_ID: '',
  }
})
afterAll(() => server.close())

function nawaban(argv: string[], session = A_SESSION) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile('node', [CLI, ...argv], { env: { ...env, CLAUDE_CODE_SESSION_ID: session }, cwd: outside }, (error, out, err) =>
      resolve({ code: error ? Number(error.code) : 0, out: stable(out), err: stable(err) }),
    )
  })
}

it('says what a write verb did in one line, and what to do next when it refuses', EVERY_STEP_STARTS_A_NODE, async () => {
  expect(await nawaban(['create', 'OUT-1', '--title', '一张票', '--project', 'p-out'])).toMatchInlineSnapshot(`
    {
      "code": 0,
      "err": "",
      "out": "✓ 建票 OUT-1：一张票
    ",
    }
  `)
  expect(await nawaban(['create', 'OUT-2', '--title', '挂在没有的票下', '--parent', 'NOPE'])).toMatchInlineSnapshot(`
    {
      "code": 1,
      "err": "✗ 没有票 NOPE
      票号照 nawaban list 里的写
    ",
      "out": "",
    }
  `)
  await nawaban(['create', 'OUT-2', '--title', '别人的票', '--project', 'p-out'])
  await nawaban(['claim', 'OUT-2'], B_SESSION)

  expect(await nawaban(['claim', 'OUT-1'])).toMatchInlineSnapshot(`
    {
      "code": 0,
      "err": "",
      "out": "✓ 认领 OUT-1，租约到 <时:分>
    ",
    }
  `)
  expect(await nawaban(['claim', 'OUT-2'])).toMatchInlineSnapshot(`
    {
      "code": 1,
      "err": "✗ OUT-2 在 cc-bbbb2222 via victor 手里，租约到 <时:分>
      等它交还，或让编排者改派
    ",
      "out": "",
    }
  `)

  expect(await nawaban(['event', 'OUT-1', 'note', '已完成：建票 / 下一步：关票'])).toMatchInlineSnapshot(`
    {
      "code": 0,
      "err": "",
      "out": "✓ OUT-1 记下进展
    ",
    }
  `)
  expect(await nawaban(['event', 'OUT-1', 'resolve', '定了'])).toMatchInlineSnapshot(`
    {
      "code": 1,
      "err": "✗ OUT-1 没有挂着等决策或等你的事
    ",
      "out": "",
    }
  `)

  expect(await nawaban(['close', 'OUT-2', '--done'])).toMatchInlineSnapshot(`
    {
      "code": 1,
      "err": "✗ OUT-2 在 cc-bbbb2222 via victor 手里，租约到 <时:分>
      等持票的 worker 自己关，或等它的租约过期
    ",
      "out": "",
    }
  `)
  expect(await nawaban(['close', 'OUT-1', '--done'])).toMatchInlineSnapshot(`
    {
      "code": 0,
      "err": "",
      "out": "✓ 关了 OUT-1（做完）
    ",
    }
  `)
})

it('starts each line of a ticket with its KEY, and refuses with what to do next', EVERY_STEP_STARTS_A_NODE, async () => {
  await nawaban(['create', 'OUT-3', '--title', '列出来的票', '--project', 'p-list'])
  await nawaban(['create', 'OUT-4', '--title', '被挡的票', '--project', 'p-list', '--blocked-by', 'OUT-3'])

  expect(await nawaban(['list', '--project', 'p-list'])).toMatchInlineSnapshot(`
    {
      "code": 0,
      "err": "",
      "out": "OUT-3  ready      列出来的票
    OUT-4  waiting    被挡的票
    ",
    }
  `)
  expect(await nawaban(['list', 'p-list'])).toMatchInlineSnapshot(`
    {
      "code": 2,
      "err": "✗ 多出来的位置参数：p-list
      加 --help 看这个动词的参数
    ",
      "out": "",
    }
  `)

  expect(await nawaban(['show', 'OUT-4'])).toMatchInlineSnapshot(`
    {
      "code": 0,
      "err": "",
      "out": "OUT-4  waiting    被挡的票

      project     p-list
      holder      none
      blocked by  OUT-3 ready
      downstream  nothing
      latest      nothing yet
    ",
    }
  `)
  expect(await nawaban(['show', 'NOPE'])).toMatchInlineSnapshot(`
    {
      "code": 1,
      "err": "✗ 没有票 NOPE
      票号照 nawaban list 里的写
    ",
      "out": "",
    }
  `)

  await nawaban(['create', 'OUT-6', '--title', '待办的票', '--project', 'p-status'])
  expect(await nawaban(['status', '--project', 'p-status'])).toMatchInlineSnapshot(`
    {
      "code": 0,
      "err": "",
      "out": "p-status 进行中的事 · <月-日 时:分> 生成
    等你 0 · 停滞 0 · 进行中 0 · 待办 1

    ## 待办 1（没人认领过）
    - OUT-6 待办的票
    ",
    }
  `)
  expect(await nawaban(['status', 'p-list'])).toMatchInlineSnapshot(`
    {
      "code": 2,
      "err": "✗ 多出来的位置参数：p-list
      加 --help 看这个动词的参数
    ",
      "out": "",
    }
  `)
})

it('prints one object for --json, a refusal too', EVERY_STEP_STARTS_A_NODE, async () => {
  const made = await nawaban(['create', 'OUT-5', '--title', 'json', '--project', 'p-json', '--json'])
  expect([made.code, JSON.parse(made.out).task.labels.key, made.err]).toEqual([0, 'OUT-5', ''])
  const refused = await nawaban(['show', 'NOPE', '--json'])
  expect([refused.code, refused.out, JSON.parse(refused.err)]).toEqual([1, '', { error: '没有票 NOPE', next: '票号照 nawaban list 里的写', code: 1 }])
  for (const argv of [['status', '--project', 'p-json'], ['list', '--project', 'p-json'], ['show', 'OUT-5'], ['claim', 'OUT-5'], ['event', 'OUT-5', 'note', 'x'], ['close', 'OUT-5', '--cancelled']]) {
    const r = await nawaban([...argv, '--json'])
    expect([argv.join(' '), r.code, typeof JSON.parse(r.out)]).toEqual([argv.join(' '), 0, 'object'])
  }
})

it('writes a ticket with no KEY by its board number, with no #', EVERY_STEP_STARTS_A_NODE, async () => {
  const { task } = await team.as(null).tasks.create('p-keyless', { text: '没有 KEY 的票' })
  for (const argv of [['status', '--project', 'p-keyless'], ['list', '--project', 'p-keyless'], ['show', task.id]]) {
    const r = await nawaban(argv)
    expect([argv[0], r.code, r.out]).toEqual([argv[0], 0, expect.stringContaining(`${task.id} `)])
    expect(r.out).not.toMatch(/#\d/)
  }
})
