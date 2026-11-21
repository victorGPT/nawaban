import { createServer, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { board } from '@vercel/board'
import type { CallerRequest } from '@vercel/board/access'
import { local } from '@vercel/board/backend-local'
import { registerSchemas } from './schemas.ts'
import { impactNames } from './impact.ts'

const DEFAULT_PORT = 4100
const TOKEN_BYTES = 32

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

export async function token(dir: string): Promise<string> {
  const path = join(dir, 'token')
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

export async function serve(dir = DIR, port = PORT) {
  const url = urlFor(port)
  const team = board({ backend: local({ dir }), authenticate: verifier(await token(dir)), url, middleware: [impactNames(dir)] })
  await registerSchemas(team)
  const server = await listen(team.fetch, port)
  console.log(`serving the board at ${url}, its log in ${dir.replace(homedir(), '~')}`)
  return server
}
