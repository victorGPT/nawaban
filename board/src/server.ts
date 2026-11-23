import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { board } from '@vercel/board'
import type { CallerRequest } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { registerSchemas } from './schemas.ts'
import { impactNames } from './impact.ts'
import { okrData } from './okr.ts'
import { Refused } from './tasks.ts'
import { boardData, projectsData, taskDetail } from './views.ts'
import { dropInboxItem, inboxEntries, keepInboxItem } from './page.ts'

const DEFAULT_PORT = 4100
const TOKEN_BYTES = 32
const WEB_TOKEN = 'web-token'
const WEB = fileURLToPath(new URL('../../web/', import.meta.url))
const BUILT_PAGE = join(WEB, 'dist')
const API = '/api/nawaban/'
const READS = new Set(['GET', 'HEAD'])
const WRITE_BODY_MAX_BYTES = 16 * 1024
const PROXY_HEADERS = /^(?:x-forwarded-.*|forwarded|x-real-ip)$/
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

type Team = ReturnType<typeof board>

export const boardDirAsConfiguredWhenAsked = () => process.env.NAWABAN_BOARD_DIR ?? join(homedir(), '.nawaban', 'board')
export const DIR = boardDirAsConfiguredWhenAsked()
export const PORT = Number(process.env.NAWABAN_BOARD_PORT ?? DEFAULT_PORT)
export const urlFor = (port: number) => `http://127.0.0.1:${port}/api/board`

async function linkIntoPlaceSoTwoFirstRunsAgreeOnOne(tmp: string, path: string) {
  try {
    await link(tmp, path)
  } catch (error) {
    const anotherRunLinkedFirst = (error as NodeJS.ErrnoException).code === 'EEXIST'
    if (!anotherRunLinkedFirst) throw error
  } finally {
    await unlink(tmp)
  }
}

export async function token(dir: string, name = 'token'): Promise<string> {
  const path = join(dir, name)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const writtenWholeBeforeAnyReaderSeesIt = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`
  await writeFile(writtenWholeBeforeAnyReaderSeesIt, randomBytes(TOKEN_BYTES).toString('hex') + '\n', { mode: 0o600, flag: 'wx' })
  await linkIntoPlaceSoTwoFirstRunsAgreeOnOne(writtenWholeBeforeAnyReaderSeesIt, path)
  const secret = (await readFile(path, 'utf8')).trim()
  if (!secret) throw new Error(`${path} is empty: delete it and start again`)
  return secret
}

export function verifier(secret: string, user = userInfo().username) {
  const want = Buffer.from(secret)
  return (request: CallerRequest) => {
    if (request.credential == null) return null
    const got = Buffer.from(request.credential)
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return Response.json({ error: { code: 'unauthorized', message: 'bad token' } }, { status: 401 })
    }
    const tokenHolderIsThisOsUserAsAPerson = { id: `local:user:${user}`, kind: 'person', handle: user } as const
    return tokenHolderIsThisOsUserAsAPerson
  }
}

export function listen(fetch: (request: Request) => Promise<Response>, port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      }
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      const response = await fetch(
        new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url}`, { method: req.method, headers, body, duplex: 'half', signal: controller.signal } as RequestInit),
      )
      res.writeHead(response.status, [...response.headers].flat())
      if (response.body) Readable.fromWeb(response.body as never).on('error', () => res.destroy()).pipe(res)
      else res.end()
    } catch (error) {
      console.error(error)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

const refuse = (status: number, message: string) => Response.json({ error: message }, { status })

function fromThisMachineDirectlyElseRefusal(request: Request, port: number) {
  const host = request.headers.get('host')
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(421, 'host must be 127.0.0.1 or localhost on this port')
  if ([...request.headers.keys()].some((name) => PROXY_HEADERS.test(name))) return refuse(421, 'no proxies')
  return null
}

function holdsTheWebTokenElseRefusal(request: Request, want: Buffer) {
  const got = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return refuse(401, 'open the page with nawaban web')
  return null
}

function writesOnlyFromThePagesOwnOriginElseRefusal(request: Request) {
  if (READS.has(request.method)) return null
  if (request.headers.get('origin') !== `http://${request.headers.get('host')}`) return refuse(403, 'origin')
  return null
}

function changes(team: Team, signal: AbortSignal) {
  const stop = new AbortController()
  signal.addEventListener('abort', () => stop.abort())
  const line = (text: string) => new TextEncoder().encode(text)
  return new Response(
    new ReadableStream({
      start(out) {
        out.enqueue(line(': live\n\n'))
        void (async () => {
          try {
            for await (const _ of team.events({}, { signal: stop.signal })) out.enqueue(line('data: changed\n\n'))
          } catch {
          } finally {
            stop.abort()
            try {
              out.close()
            } catch {}
          }
        })()
      },
      cancel() {
        stop.abort()
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
  )
}

async function view(team: Team, dir: string, path: string, query: URLSearchParams, signal: AbortSignal) {
  const [what, ...rest] = path.split('/')
  if (what === 'board' && !rest.length) return Response.json(await boardData(team, query.get('project') || undefined))
  if (what === 'projects' && !rest.length) return Response.json(await projectsData(team))
  if (what === 'okr' && !rest.length) {
    const repo = query.get('repo')
    return repo ? Response.json(await okrData(team, dir, repo)) : refuse(400, 'usage: /api/nawaban/okr?repo=<path>')
  }
  if (what === 'changes' && !rest.length) return changes(team, signal)
  if (what === 'inbox' && !rest.length) {
    const project = query.get('project')
    return project ? Response.json({ items: await inboxEntries(team, project) }) : refuse(400, 'usage: /api/nawaban/inbox?project=<name>')
  }
  if (what === 'task' && rest.length === 1 && rest[0]) {
    try {
      return Response.json(await taskDetail(team, decodeURIComponent(rest[0])))
    } catch (error) {
      if (error instanceof URIError) return refuse(400, 'bad task key')
      if (error instanceof Refused) return refuse(404, error.message)
      throw error
    }
  }
  return refuse(404, 'no such view')
}

async function wordsSent(request: Request) {
  const body = await request.text()
  if (Buffer.byteLength(body) > WRITE_BODY_MAX_BYTES) throw new Refused('too long')
  let sent: unknown
  try {
    sent = JSON.parse(body)
  } catch {
    throw new Refused('send JSON { words }')
  }
  const words = (sent as { words?: unknown } | null)?.words
  if (typeof words !== 'string') throw new Refused('send JSON { words }')
  return words
}

async function write(team: Team, path: string, query: URLSearchParams, request: Request) {
  const [what, ...rest] = path.split('/')
  if (what === 'inbox' && request.method === 'POST' && !rest.length) {
    return Response.json(await keepInboxItem(team, query.get('project') ?? '', await wordsSent(request)), { status: 201 })
  }
  if (what === 'inbox' && request.method === 'DELETE' && rest.length === 1 && rest[0]) {
    return (await dropInboxItem(team, rest[0])) ? new Response(null, { status: 204 }) : refuse(404, 'no such inbox item')
  }
  return refuse(405, 'read-only')
}

const howToBuild = () =>
  new Response(`网页还没 build:pnpm --dir ${WEB} install --frozen-lockfile && pnpm --dir ${WEB} build\n`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })

async function builtFile(pathname: string, dist: string) {
  let path
  try {
    path = resolve(dist, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname))
  } catch {
    return refuse(400, 'bad path')
  }
  if (!path.startsWith(resolve(dist) + sep)) return refuse(404, 'not found')
  try {
    return new Response(await readFile(path), { headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' } })
  } catch {
    return pathname === '/' ? howToBuild() : refuse(404, 'not found')
  }
}

export function site(team: Team, { dir, webToken, port, dist = BUILT_PAGE }: { dir: string; webToken: string; port: number; dist?: string }) {
  const want = Buffer.from(webToken)
  return async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url)
    if (pathname === '/api/board' || pathname.startsWith('/api/board/')) return team.fetch(request)
    const isApi = pathname.startsWith(API)
    const refusal =
      fromThisMachineDirectlyElseRefusal(request, port) ??
      (isApi ? (holdsTheWebTokenElseRefusal(request, want) ?? writesOnlyFromThePagesOwnOriginElseRefusal(request)) : null)
    if (refusal) return refusal
    if (!isApi) return READS.has(request.method) ? builtFile(pathname, dist) : refuse(405, 'read-only')
    const path = pathname.slice(API.length)
    try {
      return await (READS.has(request.method) ? view(team, dir, path, searchParams, request.signal) : write(team, path, searchParams, request))
    } catch (error) {
      if (error instanceof Refused) return refuse(400, error.message)
      throw error
    }
  }
}

export const pageUrl = (port: number, webToken: string) => `http://127.0.0.1:${port}/#k=${webToken}`

const openInBrowser = (url: string) =>
  new Promise<void>((done, fail) => execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], (error) => (error ? fail(error) : done())))

export async function web(dir = DIR, port = PORT, open = openInBrowser): Promise<number> {
  const secret = await token(dir, WEB_TOKEN)
  try {
    await open(pageUrl(port, secret))
  } catch {
    process.stderr.write(`打不开浏览器:自己打开 http://127.0.0.1:${port}/#k=<${join(dir, WEB_TOKEN).replace(homedir(), '~')} 的内容>\n`)
    return 1
  }
  process.stdout.write(`在浏览器打开了 http://127.0.0.1:${port}/\n`)
  return 0
}

export async function serve(dir = DIR, port = PORT) {
  const url = urlFor(port)
  const team = board({ backend: local({ dir }), authenticate: verifier(await token(dir)), url, middleware: [impactNames(dir)] })
  await registerSchemas(team)
  const server = await listen(site(team, { dir, webToken: await token(dir, WEB_TOKEN), port }), port)
  console.log(`serving the board at ${url} and its page at http://127.0.0.1:${port}/, its log in ${dir.replace(homedir(), '~')}`)
  return server
}
