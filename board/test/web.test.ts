import { request as http } from 'node:http'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { createApp } from '@vercel/board/cli'
import { listen, pageUrl, site, token, verifier, web } from '../src/server.ts'
import { inboxChannel, inboxItemText, openInboxItems } from '../src/page.ts'
import { registerSchemas } from '../src/schemas.ts'
import { run } from '../src/tasks.ts'
import { boardData, taskDetail } from '../src/views.ts'

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
  handler = site(team, { dir, webToken: WEB_SECRET, port, dist })
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
    expect((await run(argv)) ?? (await createApp({ appName: 'nawaban' }).run(argv))).toBe(0)
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

it('takes a write only from the page\'s own origin', async () => {
  expect((await send('/api/nawaban/board', { method: 'POST' })).status).toBe(403)
  expect((await send('/api/nawaban/board', { method: 'POST', headers: { origin: 'http://evil.test' } })).status).toBe(403)
  expect((await send('/api/nawaban/board', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(405)
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
  handler = site(team, { dir, webToken: WEB_SECRET, port, dist: join(dist, 'missing') })
  try {
    const r = await send('/')
    expect(r.status).toBe(404)
    expect(r.body).toContain('build')
  } finally {
    handler = site(team, { dir, webToken: WEB_SECRET, port, dist })
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
