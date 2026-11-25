import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { request as http } from 'node:http'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createApp } from '@vercel/board/cli'
import { listen, pageUrl, site, tailnetHost, token, verifier, web, webOverTailnet } from '../src/server.ts'
import { inboxChannel, inboxItemText, openInboxItems } from '../src/page.ts'
import { registerSchemas } from '../src/schemas.ts'
import { run } from '../src/tasks.ts'
import { event } from '../src/events.ts'
import { boardData, taskDetail } from '../src/views.ts'
import { theWebTokenHolderAtAShell } from '../src/github.ts'

const SECRET = 'board-secret'
const WEB_SECRET = 'web-secret'
let team: ReturnType<typeof board>
let handler: (request: Request) => Promise<Response>
let server: Awaited<ReturnType<typeof listen>>
let port = 0
let dir = ''
let dist = ''

beforeAll(async () => {
  server = await listen((request) => handler(request), 0)
  port = (server.address() as AddressInfo).port
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url: `http://127.0.0.1:${port}/api/board` })
  await registerSchemas(team)
  process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'nawaban-web-'))
  dir = await mkdtemp(join(tmpdir(), 'nawaban-web-board-'))
  dist = await mkdtemp(join(tmpdir(), 'nawaban-web-dist-'))
  await mkdir(join(dist, 'assets'))
  await writeFile(join(dist, 'index.html'), '<div id="root"></div>')
  await writeFile(join(dist, 'assets', 'page.js'), 'export {}')
  await writeFile(join(dir, 'secret.txt'), 'outside the page')
  handler = site(team, { dir, webToken: WEB_SECRET, boardToken: SECRET, port, dist })
})
afterAll(() => server.close())

type Sent = { status: number; type: string; body: string }

function send(path: string, { method = 'GET', headers = {} as Record<string, string>, raw = false, body = '' } = {}): Promise<Sent> {
  const withPageDefaults = raw ? headers : { host: `127.0.0.1:${port}`, authorization: `Bearer ${WEB_SECRET}`, ...headers }
  return new Promise((done, fail) => {
    const req = http({ host: '127.0.0.1', port, path, method, headers: withPageDefaults, setHost: false }, (res) => {
      let body = ''
      res.setEncoding('utf8').on('data', (c) => (body += c)).on('end', () => done({ status: res.statusCode!, type: String(res.headers['content-type']), body }))
    })
    req.on('error', fail).end(body)
  })
}

async function create(...argv: string[]) {
  vi.stubEnv('BOARD_URL', `http://127.0.0.1:${port}/api/board`)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  vi.stubEnv('BOARD_PROFILE', '')
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'aaaa1111-0000-0000-0000-000000000000')
  vi.stubEnv('NAWABAN_BOARD_DIR', dir)
  const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    const app = createApp({ appName: 'nawaban' })
    const [command, ...rest] = argv
    expect(command === 'event' ? await event(rest, (args) => app.run(args), board()) : ((await run(argv)) ?? (await app.run(argv)))).toBe(0)
  } finally {
    quiet.mockRestore()
    vi.unstubAllEnvs()
  }
}

it('answers the views with the JSON nawaban json prints, read through the board over HTTP', async () => {
  await create('create', 'W', '--title', '网页', '--project', 'nawaban')
  await create('create', 'W-01', '--title', '服务', '--parent', 'W')
  vi.stubEnv('BOARD_URL', `http://127.0.0.1:${port}/api/board`)
  vi.stubEnv('BOARD_TOKEN', SECRET)
  const overHttp = board()
  const [cliBoard, cliTask] = [await boardData(overHttp, 'nawaban'), await taskDetail(overHttp, 'W-01')]
  vi.unstubAllEnvs()
  expect(JSON.parse((await send('/api/nawaban/board?project=nawaban')).body)).toEqual(JSON.parse(JSON.stringify(cliBoard)))
  expect(JSON.parse((await send('/api/nawaban/task/W-01')).body)).toEqual(JSON.parse(JSON.stringify(cliTask)))
  expect(JSON.parse((await send('/api/nawaban/projects')).body).projects).toEqual([{ name: 'nawaban', open: 2, total: 2, waiting: 0 }])
})

it('answers a missing task 404, a bad key 400, an unknown view 404, okr without a repo 400', async () => {
  expect((await send('/api/nawaban/task/NOPE')).status).toBe(404)
  expect((await send('/api/nawaban/task/%E0%A4%A')).status).toBe(400)
  expect((await send('/api/nawaban/nothing')).status).toBe(404)
  expect((await send('/api/nawaban/okr')).status).toBe(400)
  expect((await send(`/api/nawaban/okr?repo=${encodeURIComponent(dir)}`)).status).toBe(400)
})

it('finds a project\'s okr through repos.json', async () => {
  const repo = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-web-repo-')))
  const bare = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-web-bare-')))
  await mkdir(join(repo, 'docs/agents'), { recursive: true })
  await writeFile(join(repo, 'docs/agents/okr.toml'), '[[objective]]\nname = "O"\n\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\n')
  for (const r of [repo, bare]) execFileSync('git', ['init', '-q'], { cwd: r })
  await writeFile(join(dir, 'repos.json'), JSON.stringify({ nawaban: repo, bare }))
  const okr = await send('/api/nawaban/okr?project=nawaban')
  expect(okr.status).toBe(200)
  expect(JSON.parse(okr.body).objectives.map((o: { name: string }) => o.name)).toEqual(['O'])
  expect(JSON.parse((await send('/api/nawaban/okr?project=bare')).body).error).toMatch(/^没有 docs\/agents\/okr.toml/)
  expect((await send('/api/nawaban/okr?project=nobody')).status).toBe(404)
  expect((await send('/api/nawaban/okr?project=constructor')).status).toBe(404)
})

it('turns away a caller without the web token, and the board token is not it', async () => {
  expect((await send('/api/nawaban/board', { headers: { authorization: '' } })).status).toBe(401)
  expect((await send('/api/nawaban/board', { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(401)
  expect((await send('/api/board/tasks', { headers: { authorization: `Bearer ${WEB_SECRET}` } })).status).toBe(401)
  expect((await send('/api/board/tasks', { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(200)
})

it('answers only this machine by its own name, never through a proxy', async () => {
  expect((await send('/api/nawaban/board', { headers: { host: `localhost:${port}` } })).status).toBe(200)
  expect((await send('/api/nawaban/board', { headers: { host: `x@127.0.0.1:${port}` } })).status).toBeGreaterThanOrEqual(400)
  for (const host of ['evil.test', `evil.test:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `127.0.0.1.evil.test:${port}`, `LOCALHOST:${port}`]) {
    expect((await send('/api/nawaban/board', { headers: { host } })).status, host).toBe(421)
    expect((await send('/', { headers: { host } })).status, host).toBe(421)
  }
  for (const proxied of ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip']) {
    expect((await send('/api/nawaban/board', { headers: { [proxied]: '10.0.0.1' } })).status, proxied).toBe(421)
  }
  expect((await send('/api/nawaban/board', { raw: true })).status).toBeGreaterThanOrEqual(400)
})

it('answers tailscale serve for the tailnet host only when the switch names it, and takes writes from its https origin', async () => {
  const TAILNET = 'mac.tail0000.ts.net'
  const viaServe = { host: TAILNET, 'x-forwarded-host': TAILNET, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.110.54.23', 'tailscale-user-login': 'me@example.test' }
  expect((await send('/api/nawaban/board', { headers: viaServe })).status, 'switch off').toBe(421)
  const local = handler
  handler = site(team, { dir, webToken: WEB_SECRET, boardToken: SECRET, port, dist, tailnet: TAILNET })
  try {
    expect((await send('/api/nawaban/board', { headers: viaServe })).status).toBe(200)
    expect((await send('/', { headers: viaServe })).status).toBe(200)
    expect((await send('/api/nawaban/board', { headers: { ...viaServe, 'x-forwarded-for': 'fd7a:115c:a1e0::6d38:3618' } })).status).toBe(200)
    expect((await send('/api/nawaban/board', { headers: { host: `127.0.0.1:${port}` } })).status, 'this machine still').toBe(200)
    expect((await send('/api/nawaban/board', { headers: { ...viaServe, authorization: '' } })).status, 'token still').toBe(401)
    const forged: Record<string, Record<string, string>> = {
      'other host': { ...viaServe, host: 'evil.test', 'x-forwarded-host': 'evil.test' },
      'host with port': { ...viaServe, host: `${TAILNET}:${port}` },
      'host suffix': { ...viaServe, host: `${TAILNET}.evil.test`, 'x-forwarded-host': `${TAILNET}.evil.test` },
      'forwarded host differs': { ...viaServe, 'x-forwarded-host': 'evil.test' },
      'plain http': { ...viaServe, 'x-forwarded-proto': 'http' },
      'not from the tailnet': { ...viaServe, 'x-forwarded-for': '203.0.113.9' },
      'a chain of proxies': { ...viaServe, 'x-forwarded-for': '203.0.113.9, 100.110.54.23' },
      'just past the tailnet range': { ...viaServe, 'x-forwarded-for': '100.128.0.1' },
      'forwarded too': { ...viaServe, forwarded: 'for=100.110.54.23' },
      'real ip too': { ...viaServe, 'x-real-ip': '100.110.54.23' },
      'no forwarding headers': { host: TAILNET },
    }
    for (const [why, headers] of Object.entries(forged)) expect((await send('/api/nawaban/board', { headers })).status, why).toBe(421)
    const write = (origin: string) => send('/api/nawaban/board', { method: 'POST', headers: { ...viaServe, origin } })
    expect((await write(`https://${TAILNET}`)).status).toBe(405)
    expect((await write(`http://${TAILNET}`)).status).toBe(403)
    expect((await write('https://evil.test')).status).toBe(403)
  } finally {
    handler = local
  }
})

it('reads the tailnet switch from the board dir, and prints the tailnet link with the token only when it is on', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nawaban-web-tailnet-'))
  expect(await tailnetHost(home)).toBeUndefined()
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  let printed = ''
  try {
    expect(await webOverTailnet(home)).toBe(1)
    await writeFile(join(home, 'tailnet'), 'mac.tail0000.ts.net\n')
    expect(await tailnetHost(home)).toBe('mac.tail0000.ts.net')
    expect(await webOverTailnet(home)).toBe(0)
    printed = out.mock.calls.flat().join('')
  } finally {
    err.mockRestore()
    out.mockRestore()
  }
  expect(printed).toBe(`https://mac.tail0000.ts.net/#k=${await token(home, 'web-token')}\n`)
  await writeFile(join(home, 'tailnet'), 'evil.test:443 x')
  await expect(tailnetHost(home)).rejects.toThrow(/host name/)
})

it('takes a write only from the page\'s own origin', async () => {
  expect((await send('/api/nawaban/board', { method: 'POST' })).status).toBe(403)
  expect((await send('/api/nawaban/board', { method: 'POST', headers: { origin: 'http://evil.test' } })).status).toBe(403)
  expect((await send('/api/nawaban/board', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(405)
})

it('writes an answer to a held question, naming it by its words, and keeps the hold', async () => {
  await create('create', 'Q1', '--title', '问一句', '--project', 'question')
  const id = (await team.tasks.list({ state: 'all', label: { key: 'Q1' } })).tasks[0]!.message.id
  const asPage = (answer: unknown) =>
    send('/api/nawaban/answer/Q1', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify(answer) })
  const waitingOf = async () => JSON.parse((await send('/api/nawaban/board?project=question')).body).columns.flatMap((c: { tasks: { id: string; waiting: string | null }[] }) => c.tasks).find((t: { id: string }) => t.id === 'Q1').waiting as string | null

  expect((await asPage({ ask: '哪天上线', words: '还没问' })).status).toBe(409)
  await create('event', id, 'wait', '哪天上线')
  expect(await waitingOf()).toBe('哪天上线')
  expect((await asPage({ ask: '另一个问题', words: '周五' })).status).toBe(409)

  const written = await asPage({ ask: '哪天上线', words: '周五' })
  expect(written.status).toBe(201)
  expect(JSON.parse(written.body)).toMatchObject({ task: 'Q1', option: null, words: '周五', hold: 'needs_input', by: 'victor' })
  expect((await team.thread(id)).message.task?.blocked?.kind).toBe('needs_input')
  expect(JSON.parse((await send('/api/nawaban/answers?project=question')).body).answers).toMatchObject([{ task: 'Q1', words: '周五' }])

  await create('event', id, 'resolve', '周五上线')
  await create('event', id, 'wait', '要不要灰度')
  expect(JSON.parse((await send('/api/nawaban/answers?project=question')).body).answers).toEqual([])
  expect((await asPage({ ask: '哪天上线', words: '对旧问题的答复' })).status).toBe(409)
})

it('writes an answer to a 待决 as the local person, keeps the hold, and reads it back', async () => {
  await create('create', 'D1', '--title', '发不发', '--project', 'decide')
  const id = (await team.tasks.list({ state: 'all', label: { key: 'D1' } })).tasks[0]!.message.id
  const asPage = (key: string, answer: unknown) =>
    send(`/api/nawaban/answer/${key}`, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify(answer) })

  expect((await asPage('D1', { ask: 'none', words: '还没挂' })).status).toBe(409)
  await create('event', id, '--kind', 'ask', '--body', '发不发', '--kr', 'K', '--context', '事实', '--option', '发｜快｜two-way', '--option', '不发｜稳｜two-way', '--rec', '发')

  const askOf = async () => JSON.parse((await send('/api/nawaban/board?project=decide')).body).columns.flatMap((c: { tasks: { id: string; pending?: { ask: string } }[] }) => c.tasks).find((t: { id: string }) => t.id === 'D1').pending.ask as string
  const ask = await askOf()
  for (const bad of [{}, { ask, words: '' }, { ask, words: '  ' }, { ask, words: 1 }, { ask, words: 'x', option: '' }, { ask, words: 'x', resolve: true }, { words: 'x' }, { ask: 1, words: 'x' }, ['x'], 'x'.repeat(3)]) {
    expect((await asPage('D1', bad)).status, JSON.stringify(bad)).toBe(400)
  }
  expect((await asPage('NOPE', { ask, words: '发' })).status).toBe(409)
  expect((await asPage('%E0%A4%A', { ask, words: '发' })).status).toBe(400)
  expect((await asPage('D1', { ask: 'another-card', words: '发' })).status).toBe(409)
  expect((await send('/api/nawaban/answer/D1', { method: 'POST', headers: { origin: 'http://evil.test' }, body: '{"words":"发"}' })).status).toBe(403)

  const written = await asPage('D1', { ask, option: '发', words: '就这么定' })
  expect(written.status).toBe(201)
  expect(JSON.parse(written.body)).toMatchObject({ task: 'D1', option: '发', words: '就这么定', by: 'victor' })
  const thread = await team.thread(id)
  expect(thread.message.task?.blocked?.kind).toBe('awaiting_approval')
  expect(thread.replies.at(-1)?.author).toMatchObject({ kind: 'person', handle: 'victor' })
  expect(JSON.parse((await send('/api/nawaban/answers?project=decide')).body).answers).toMatchObject([{ task: 'D1', option: '发', words: '就这么定' }])
  expect(JSON.parse((await send('/api/nawaban/answers?project=nawaban')).body).answers).toEqual([])

  await team.tasks.unblock(id)
  await create('event', id, '--kind', 'ask', '--body', '还发不发', '--kr', 'K', '--context', '新事实', '--option', '发｜快｜two-way', '--option', '不发｜稳｜two-way', '--rec', '不发')
  expect(await askOf()).not.toBe(ask)
  expect((await asPage('D1', { ask, option: '发', words: '对旧卡的答复' })).status).toBe(409)
  expect(JSON.parse((await send('/api/nawaban/answers?project=decide')).body).answers).toEqual([])

  const fetchOfTheBoard = team.fetch
  team.fetch = async (request) => {
    team.fetch = fetchOfTheBoard
    await team.reply(id, { text: '进展：检查和写入之间插进一条' })
    return fetchOfTheBoard.call(team, request)
  }
  expect((await asPage('D1', { ask: await askOf(), words: '晚到的答复' })).status).toBe(409)
  team.fetch = fetchOfTheBoard
  expect(JSON.parse((await send('/api/nawaban/answers?project=decide')).body).answers).toEqual([])
})

it('serves the built page without a token, and nothing outside it', async () => {
  const page = await send('/', { headers: { authorization: '' } })
  expect(page).toMatchObject({ status: 200, body: '<div id="root"></div>' })
  expect(page.type).toContain('text/html')
  expect((await send('/assets/page.js')).type).toContain('text/javascript')
  expect((await send('/assets/none.js')).status).toBe(404)
  for (const escape of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e%2fsecret.txt']) {
    const r = await send(escape)
    expect(r.status, escape).not.toBe(200)
    expect(r.body, escape).not.toContain('outside the page')
  }
})

it('answers / with how to build when the page is not built', async () => {
  handler = site(team, { dir, webToken: WEB_SECRET, boardToken: SECRET, port, dist: join(dist, 'missing') })
  try {
    const r = await send('/')
    expect(r.status).toBe(404)
    expect(r.body).toContain('build')
  } finally {
    handler = site(team, { dir, webToken: WEB_SECRET, boardToken: SECRET, port, dist })
  }
})

it('says something changed when the board moves', async () => {
  const stop = new AbortController()
  const r = await fetch(`http://127.0.0.1:${port}/api/nawaban/changes`, { headers: { authorization: `Bearer ${WEB_SECRET}` }, signal: stop.signal })
  expect(r.headers.get('content-type')).toBe('text/event-stream')
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader()
  expect((await reader.read()).value).toContain(': live')
  await create('create', 'W-02', '--title', '推送', '--parent', 'W')
  let seen = ''
  while (!seen.includes('data: changed')) seen += (await reader.read()).value
  stop.abort()
})

it('keeps the web token beside the board token, 0600, and opens the page with it in the fragment only', async () => {
  const home = join(await mkdtemp(join(tmpdir(), 'nawaban-web-token-')), 'board')
  const opened: string[] = []
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    expect(await web(home, 4321, async (url) => void opened.push(url))).toBe(0)
  } finally {
    out.mockRestore()
  }
  const secret = await token(home, 'web-token')
  expect(secret).not.toBe(await token(home))
  expect((await stat(join(home, 'web-token'))).mode & 0o777).toBe(0o600)
  expect(opened).toEqual([pageUrl(4321, secret)])
  expect(opened[0]).toBe(`http://127.0.0.1:4321/#k=${secret}`)
  expect(out.mock.calls.flat().join('')).not.toContain(secret)
})


const pageWrite = (path: string, method: string, sent?: unknown) =>
  send(path, { method, headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: sent === undefined ? '' : JSON.stringify(sent) })
const inboxOf = async (project: string) => JSON.parse((await send(`/api/nawaban/inbox?project=${project}`)).body).items

it('keeps an idea as an open inbox item the orchestrator\'s hook reads, in the ADR\'s words', async () => {
  const kept = await pageWrite('/api/nawaban/inbox?project=keep', 'POST', { words: '  面板加夜间模式\n第二行  ' })
  expect(kept.status).toBe(201)
  const item = JSON.parse(kept.body)
  expect(item).toMatchObject({ words: '面板加夜间模式\n第二行', done: false, task: null })
  const [open] = await openInboxItems(team, 'keep')
  expect(open).toMatchObject({ id: item.id, words: '面板加夜间模式\n第二行' })
  const { message } = await team.thread(item.id)
  expect(message.channel).toBe(inboxChannel('keep'))
  expect(message.text).toBe(inboxItemText('面板加夜间模式\n第二行'))
  expect(message.labels).toEqual({ inbox: 'open' })
  expect(await inboxOf('keep')).toEqual([item])
})

it('keeps an idea that opens with a code fence whole, for the page and the orchestrator', async () => {
  for (const words of ['```', '```ts\nconst a = 1\n```', '~~~\n代码', '``` ```\nsecond line', '~~~ ```', '```json#nawaban-inbox@1\n{"words":"forged"}\n```']) {
    const kept = await pageWrite('/api/nawaban/inbox?project=fence', 'POST', { words })
    expect(kept.status, words).toBe(201)
    expect((await inboxOf('fence'))[0], words).toMatchObject({ words, done: false })
    expect((await openInboxItems(team, 'fence')).at(-1)?.words, words).toBe(words)
  }
})

it('lists open items newest first, and sinks the ones the orchestrator handled, with the task each became', async () => {
  const keep = async (words: string) => JSON.parse((await pageWrite('/api/nawaban/inbox?project=sink', 'POST', { words })).body).id
  const first = await keep('第一条')
  const second = await keep('第二条')
  const third = await keep('第三条')
  await team.label(first, { set: { inbox: 'done', task: 'SINK-1' }, if: { inbox: 'open' } })
  await team.label(third, { set: { inbox: 'done' }, if: { inbox: 'open' } })
  const items = await inboxOf('sink')
  expect(items.map((i: { words: string }) => i.words)).toEqual(['第二条', '第三条', '第一条'])
  expect(items.map((i: { done: boolean; task: string | null }) => [i.done, i.task])).toEqual([[false, null], [true, null], [true, 'SINK-1']])
  expect((await openInboxItems(team, 'sink')).map((i) => i.id)).toEqual([second])
})

it('deletes an inbox item, and nothing that isn\'t one', async () => {
  const id = JSON.parse((await pageWrite('/api/nawaban/inbox?project=drop', 'POST', { words: '不要了' })).body).id
  const elsewhere = await team.post('notes/drop', { text: inboxItemText('像收件箱，但不在收件箱频道') })
  const plain = await team.post(inboxChannel('drop'), { text: '收件箱频道里的普通消息' })
  const reply = await team.reply(id, { text: inboxItemText('回复不是条目') })
  for (const other of [elsewhere.id, plain.id, reply.id, 'no-such-id']) {
    expect((await pageWrite(`/api/nawaban/inbox/${other}`, 'DELETE')).status, other).toBe(404)
  }
  expect((await team.thread(elsewhere.id)).message.deleted).toBeFalsy()
  expect((await pageWrite(`/api/nawaban/inbox/${id}`, 'DELETE')).status).toBe(204)
  expect(await inboxOf('drop')).toEqual([])
  expect(await openInboxItems(team, 'drop')).toEqual([])
  expect((await pageWrite(`/api/nawaban/inbox/${id}`, 'DELETE')).status).toBe(404)
})

it('refuses an inbox write it can\'t keep, and keeps nothing', async () => {
  const refused = [
    ['/api/nawaban/inbox?project=bad', { words: '   ' }],
    ['/api/nawaban/inbox?project=bad', { words: 'x'.repeat(2001) }],
    ['/api/nawaban/inbox?project=bad', { text: '不是 words' }],
    ['/api/nawaban/inbox?project=bad', 'words'],
    ['/api/nawaban/inbox', { words: '没有项目' }],
    ['/api/nawaban/inbox?project=a/b', { words: '项目带斜杠' }],
    ['/api/nawaban/inbox?project=bad', { words: 'a\u0000b' }],
  ] as const
  for (const [path, sent] of refused) expect((await pageWrite(path, 'POST', sent)).status, JSON.stringify(sent)).toBe(400)
  const raw = await send('/api/nawaban/inbox?project=bad', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}` }, body: '{' })
  expect(raw.status).toBe(400)
  expect((await send('/api/nawaban/inbox?project=bad', { method: 'POST', headers: { origin: 'http://evil.test' }, body: '{"words":"x"}' })).status).toBe(403)
  expect((await send('/api/nawaban/inbox?project=bad', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, authorization: '' }, body: '{"words":"x"}' })).status).toBe(401)
  expect((await pageWrite('/api/nawaban/inbox?project=bad', 'PUT', { words: 'x' })).status).toBe(405)
  expect((await send('/api/nawaban/inbox')).status).toBe(400)
  expect(await inboxOf('bad')).toEqual([])
})

it('reads a GitHub-tracked repository in repos.json through the old CLI, and answers its 待决 with an 已决', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'nawaban-web-roubao-'))
  await mkdir(join(repo, 'docs', 'agents'), { recursive: true })
  await writeFile(join(repo, 'docs', 'agents', 'issue-tracker.md'), '# Issue tracker: GitHub\n')
  const ghDir = await mkdtemp(join(tmpdir(), 'nawaban-web-gh-board-'))
  await writeFile(join(ghDir, 'repos.json'), JSON.stringify({ roubao: repo, nawaban: dir }))
  let pending: { ask: string } | null = { ask: 'c1:0' }
  const calls: string[][] = []
  const githubBoard = { tracker: 'github', columns: [{ key: 'open', tasks: [{ id: '#7', status: 'open', pending }] }, { key: 'done', tasks: [{ id: '#6', status: 'done' }] }] }
  const cli = async (at: string, args: string[]) => {
    expect(at).toBe(repo)
    calls.push(args)
    if (args[1] === 'board') return JSON.stringify(githubBoard)
    if (args[1] === 'okr') return JSON.stringify({ repo, objectives: [] })
    if (args[1] === 'task') return JSON.stringify({ id: args[2], pending })
    pending = null
    return '✓ event'
  }
  handler = site(team, { dir: ghDir, webToken: WEB_SECRET, boardToken: SECRET, port, dist, cli })
  try {
    expect(JSON.parse((await send('/api/nawaban/board?project=roubao')).body)).toEqual(githubBoard)
    await send('/api/nawaban/board?project=roubao')
    expect(calls.filter((c) => c[1] === 'board'), 'one gh read serves reads close together').toHaveLength(1)
    expect(JSON.parse((await send('/api/nawaban/projects')).body).projects).toContainEqual({ name: 'roubao', open: 1, total: 2, waiting: 1 })
    expect(JSON.parse((await send('/api/nawaban/okr?project=roubao')).body)).toEqual({ repo, objectives: [] })
    expect(JSON.parse((await send('/api/nawaban/task/%237?project=roubao')).body)).toEqual({ id: '#7', pending })
    expect((await send('/api/nawaban/task/--help?project=roubao')).status).toBe(404)

    const asPage = (key: string, answer: unknown) =>
      send(`/api/nawaban/answer/${encodeURIComponent(key)}?project=roubao`, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify(answer) })
    expect((await asPage('#7', { ask: 'an-older-card', words: '发' })).status).toBe(409)
    expect((await asPage('--kind', { ask: 'c1:0', words: '发' })).status).toBe(409)
    const written = await asPage('#7', { ask: 'c1:0', option: 'A', words: '就这么定' })
    expect(written.status).toBe(201)
    expect(JSON.parse(written.body)).toMatchObject({ task: '#7', option: 'A', words: '就这么定' })
    expect(calls.at(-1)).toEqual(['event', '#7', '--kind', 'resolve', '--by', 'user', '--body', '选 A：就这么定'])
    expect((await asPage('#7', { ask: 'c1:0', words: '再答一次' })).status).toBe(409)
    await send('/api/nawaban/board?project=roubao')
    expect(calls.filter((c) => c[1] === 'board'), 'an answer makes the next read fresh').toHaveLength(2)
    const later = Date.now() + 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      await send('/api/nawaban/projects')
    } finally {
      vi.restoreAllMocks()
    }
    expect(calls.filter((c) => c[1] === 'board'), 'projects reads a stale GitHub board again').toHaveLength(3)
  } finally {
    handler = site(team, { dir, webToken: WEB_SECRET, boardToken: SECRET, port, dist })
  }
})

it('runs the old CLI as the token holder at a shell, so it may record an 已决 under a name', () => {
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'aaaa1111-0000-0000-0000-000000000000')
  vi.stubEnv('HC_TERMINAL_ID', 't1')
  vi.stubEnv('CODEX_THREAD_ID', 'codex-1')
  try {
    const said = execFileSync('python3', ['-c', 'from nawaban.cli import identity, _orchestrator_here; print(identity(), _orchestrator_here())'], {
      cwd: join(import.meta.dirname, '..', '..'),
      env: theWebTokenHolderAtAShell('victor'),
      encoding: 'utf8',
    })
    expect(said.trim()).toBe('victor True')
  } finally {
    vi.unstubAllEnvs()
  }
})
