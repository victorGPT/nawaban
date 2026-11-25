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
import { inspector } from '@vercel/board/inspect'
import { registerSchemas } from './schemas.ts'
import { impactNames, reposReadOnEveryUseSoEditsNeedNoRestart } from './impact.ts'
import { githubBoards, githubRepos, ISSUE_KEY, oldCli, projectOfGithub, type OldCli } from './github.ts'
import { currentGithubAsk, githubRepliesOf, HELD_FOR_A_GITHUB_ASK, settleIssueTasks, type KnownIssue } from './github-tasks.ts'
import { deliverAsSignedWebhook, ghReader, githubSyncConfig, importOnlySync, pollForever, readerToken, refusingGithubWrites, webhookSecret } from './github-sync.ts'
import { okrData } from './okr.ts'
import { noPullStates, pullStateFromGitHub, type PullStateOf } from './pulls.ts'
import { Refused } from './said.ts'
import { boardData, projectsData, taskDetail } from './views.ts'
import { ANSWERS_LABEL, answerToTheCurrentHold, dropInboxItem, inboxEntries, keepInboxItem, webAnswers, webAnswerText } from './page.ts'

const DEFAULT_PORT = 4100
const TOKEN_BYTES = 32
const WEB_TOKEN = 'web-token'
const TAILNET_HOST_FILE = 'tailnet'
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const TAILNET_ADDRESS = /^(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|fd7a:115c:a1e0:[0-9a-f:]+)$/i
const WEB = fileURLToPath(new URL('../../web/', import.meta.url))
const BUILT_PAGE = join(WEB, 'dist')
const API = '/api/nawaban/'
const INSPECTOR = '/board'
const INSPECTOR_OPENS_ON = '/board/tasks'
const INSPECTOR_API = INSPECTOR + '/board'
const SEGMENT = '[^/]+'
const NATIVE_GETS_THAT_ONLY_READ = new RegExp(
  `^(?:/|/me|/channels|/actors|/messages|/messages/${SEGMENT}(?:/sync)?|/threads|/links|/schedules|/tasks|/tasks/batch/${SEGMENT}|/grants|/grants/explain|/schemas|/schemas/${SEGMENT}|/posts/${SEGMENT}|/inbox/${SEGMENT}|/sync/threads/${SEGMENT}|/sync/find|/sync/copies|/events|/avatars/${SEGMENT}|/attachments/${SEGMENT}|/openapi\\.json|/watchers)$`,
)
const WEB_TOKEN_COOKIE = 'nawaban-web-token'
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
type Github = { cli: OldCli; boards: ReturnType<typeof githubBoards>; wrote: EventTarget }
const WROTE = 'wrote'

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

export async function tailnetHost(dir: string): Promise<string | undefined> {
  let named
  try {
    named = (await readFile(join(dir, TAILNET_HOST_FILE), 'utf8')).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!HOSTNAME.test(named)) throw new Error(`${join(dir, TAILNET_HOST_FILE)} must hold one lowercase host name like mymac.tailnet.ts.net, not "${named}"`)
  return named
}

const refuse = (status: number, message: string) => Response.json({ error: message }, { status })

function sentByTailscaleServeForThisHost(request: Request, tailnet: string | undefined) {
  const said = (name: string) => request.headers.get(name)
  return (
    tailnet !== undefined &&
    said('host') === tailnet &&
    said('x-forwarded-host') === tailnet &&
    said('x-forwarded-proto') === 'https' &&
    TAILNET_ADDRESS.test(said('x-forwarded-for') ?? '') &&
    !request.headers.has('forwarded') &&
    !request.headers.has('x-real-ip')
  )
}

function fromThisMachineOrTheTailnetElseRefusal(request: Request, port: number, tailnet: string | undefined) {
  if (sentByTailscaleServeForThisHost(request, tailnet)) return null
  const host = request.headers.get('host')
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(421, 'host must be 127.0.0.1 or localhost on this port')
  if ([...request.headers.keys()].some((name) => PROXY_HEADERS.test(name))) return refuse(421, 'no proxies')
  return null
}

const bearerOf = (request: Request) => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
const webTokenCookieOf = (request: Request) =>
  request.headers.get('cookie')?.split(/;\s*/).find((c) => c.startsWith(WEB_TOKEN_COOKIE + '='))?.slice(WEB_TOKEN_COOKIE.length + 1) ?? ''

function holdsTheWebTokenElseRefusal(presented: string, want: Buffer) {
  const got = Buffer.from(presented)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return refuse(401, 'open the page with nawaban web')
  return null
}

function writesOnlyFromThePagesOwnOriginElseRefusal(request: Request, tailnet: string | undefined) {
  if (READS.has(request.method)) return null
  const host = request.headers.get('host')
  const pageOrigin = host === tailnet ? `https://${host}` : `http://${host}`
  if (request.headers.get('origin') !== pageOrigin) return refuse(403, 'origin')
  return null
}

function changes(team: Team, signal: AbortSignal, githubWrote: EventTarget) {
  const stop = new AbortController()
  signal.addEventListener('abort', () => stop.abort())
  const line = (text: string) => new TextEncoder().encode(text)
  return new Response(
    new ReadableStream({
      start(out) {
        out.enqueue(line(': live\n\n'))
        const changed = () => {
          try {
            out.enqueue(line('data: changed\n\n'))
          } catch {}
        }
        githubWrote.addEventListener(WROTE, changed, { signal: stop.signal })
        void (async () => {
          try {
            for await (const _ of team.events({}, { signal: stop.signal })) changed()
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

async function githubRepoOf(dir: string, project: string | null, evenWhenSyncedToTheBoard = false) {
  const repos = project ? await githubRepos(dir, { evenWhenSyncedToTheBoard }) : {}
  return project && Object.hasOwn(repos, project) ? repos[project]! : null
}

async function allProjects(team: Team, dir: string, github: Github) {
  const onTheBoard = (await projectsData(team)).projects
  const shown = new Set(onTheBoard.map((p) => p.name))
  const onGithub = Object.entries(await githubRepos(dir)).filter(([name]) => !shown.has(name))
  for (const [, repo] of onGithub) github.boards.board(repo).catch(() => {})
  const projects = [...onTheBoard, ...onGithub.map(([name, repo]) => projectOfGithub(name, github.boards.latest(repo)))]
  return { projects: projects.sort((a, b) => (a.name < b.name ? -1 : 1)) }
}

const issueKeyOf = (segment: string) => {
  const key = decodeURIComponent(segment)
  return ISSUE_KEY.test(key) ? key : null
}

async function githubView(github: Github, repo: string, what: string | undefined, rest: string[]) {
  if (what === 'board' && !rest.length) return Response.json(await github.boards.board(repo))
  if (what === 'okr' && !rest.length) return Response.json(JSON.parse(await github.cli(repo, ['json', 'okr', '--repo', repo])))
  if (what === 'task' && rest.length === 1 && rest[0]) {
    let key
    try {
      key = issueKeyOf(rest[0])
    } catch {
      return refuse(400, 'bad task key')
    }
    if (!key) return refuse(404, `任务不存在:${rest[0]}`)
    try {
      return Response.json(JSON.parse(await github.cli(repo, ['json', 'task', key])))
    } catch (error) {
      if (error instanceof Refused) return refuse(404, error.message)
      throw error
    }
  }
  return null
}

async function view(team: Team, dir: string, pullStateOf: PullStateOf, github: Github, path: string, query: URLSearchParams, signal: AbortSignal) {
  const [what, ...rest] = path.split('/')
  const okrStaysOnGithubUntilItsReadingsMove = what === 'okr'
  const repo = await githubRepoOf(dir, query.get('project'), okrStaysOnGithubUntilItsReadingsMove)
  const onGithub = repo && (await githubView(github, repo, what, rest))
  if (onGithub) return onGithub
  if (what === 'board' && !rest.length) return Response.json(await boardData(team, query.get('project') || undefined, dir))
  if (what === 'projects' && !rest.length) return Response.json(await allProjects(team, dir, github))
  if (what === 'okr' && !rest.length) {
    const project = query.get('project')
    const repos = project ? await reposReadOnEveryUseSoEditsNeedNoRestart(dir) : {}
    const repo = query.get('repo') ?? (project && Object.hasOwn(repos, project) ? repos[project] : null)
    if (repo) return Response.json(await okrData(team, dir, repo))
    return project ? refuse(404, `项目 ${project} 没在 repos.json 登记仓库`) : refuse(400, 'usage: /api/nawaban/okr?project=<name>|repo=<path>')
  }
  if (what === 'changes' && !rest.length) return changes(team, signal, github.wrote)
  if (what === 'answers' && !rest.length) return Response.json({ answers: await webAnswers(team, query.get('project') || undefined) })
  if (what === 'inbox' && !rest.length) {
    const project = query.get('project')
    return project ? Response.json({ items: await inboxEntries(team, project) }) : refuse(400, 'usage: /api/nawaban/inbox?project=<name>')
  }
  if (what === 'task' && rest.length === 1 && rest[0]) {
    try {
      return Response.json(await taskDetail(team, decodeURIComponent(rest[0]), pullStateOf))
    } catch (error) {
      if (error instanceof URIError) return refuse(400, 'bad task key')
      if (error instanceof Refused) return refuse(404, error.message)
      throw error
    }
  }
  return refuse(404, 'no such view')
}

async function jsonSent(request: Request, shape: string): Promise<unknown> {
  const body = await request.text()
  if (Buffer.byteLength(body) > WRITE_BODY_MAX_BYTES) throw new Refused('too long')
  try {
    return JSON.parse(body)
  } catch {
    throw new Refused(`send JSON ${shape}`)
  }
}

async function wordsSent(request: Request) {
  const sent = await jsonSent(request, '{ words }')
  const words = (sent as { words?: unknown } | null)?.words
  if (typeof words !== 'string') throw new Refused('send JSON { words }')
  return words
}

const ANSWER_SHAPE = '{ ask, option?, words }'
const LONGEST_ANSWER = 2000

function answerSent(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Refused(`send JSON ${ANSWER_SHAPE}`)
  const { ask, option, words, ...extra } = body as Record<string, unknown>
  if (Object.keys(extra).length) throw new Refused(`send JSON ${ANSWER_SHAPE}`)
  const said = (v: unknown) => typeof v === 'string' && v.trim() !== '' && v.length <= LONGEST_ANSWER
  if (!said(ask)) throw new Refused('ask must name the card answered')
  if (!said(words)) throw new Refused('words must be text')
  if (option !== undefined && !said(option)) throw new Refused('option must be text')
  return { ask: ask as string, answer: { words: words as string, ...(option !== undefined && { option: option as string }) } }
}

const theCardChanged = (ref: string) => refuse(409, `${ref} 的待决卡已经换了，刷新后再答`)

async function answer(team: Team, asThisPerson: (body: unknown) => Promise<Response>, segment: string, request: Request) {
  let ref
  try {
    ref = decodeURIComponent(segment)
  } catch {
    return refuse(400, 'bad task key')
  }
  const said = answerSent(await jsonSent(request, ANSWER_SHAPE))
  const [listed] = await team.tasks.list({ state: 'blocked', label: { key: ref } }).then((p) => p.tasks.map((t) => t.message))
  if (!listed) return refuse(409, `${ref} 没有在等决策者答复`)
  const { message: task, replies } = await team.thread(listed.id)
  const hold = task.task?.blocked
  if (hold?.kind !== 'awaiting_approval' && hold?.kind !== 'needs_input') return refuse(409, `${ref} 没有在等决策者答复`)
  const githubReplies = await githubRepliesOf(team, task, replies)
  const aQuestionNamesItsHoldByItsWords = hold.kind === 'needs_input'
  const current = aQuestionNamesItsHoldByItsWords ? null : hold.reason.startsWith(HELD_FOR_A_GITHUB_ASK) ? currentGithubAsk(githubReplies) : replies.findLast((m) => !m.deleted && m.blocks.some((b) => b.schema === 'nawaban-ask'))
  if ((aQuestionNamesItsHoldByItsWords ? hold.reason : current?.id) !== said.ask) return theCardChanged(ref)
  const boundToTheGithubAskItAnswers = current && current.from === 'github' ? { labels: { [ANSWERS_LABEL]: current.id } } : {}
  const posted = await asThisPerson({ re: task.id, after: (replies.at(-1) ?? task).id, text: webAnswerText(said.answer), ...boundToTheGithubAskItAnswers })
  if (posted.status === 409) return theCardChanged(ref)
  if (!posted.ok) return refuse(502, `看板没收下答复：${posted.status}`)
  const written = await team.thread(task.id)
  return Response.json(answerToTheCurrentHold(written.message, written.replies, await githubRepliesOf(team, written.message, written.replies)), { status: 201 })
}

async function answerOnGithub(github: Github, repo: string, segment: string, request: Request) {
  let key
  try {
    key = issueKeyOf(segment)
  } catch {
    return refuse(400, 'bad task key')
  }
  const said = answerSent(await jsonSent(request, ANSWER_SHAPE))
  if (!key) return refuse(409, `${segment} 没有在等决策者答复`)
  const { pending } = JSON.parse(await github.cli(repo, ['json', 'task', key])) as { pending?: { ask?: string } | null }
  if (!pending) return refuse(409, `${key} 没有在等决策者答复`)
  if (pending.ask !== said.ask) return theCardChanged(key)
  const { option, words } = said.answer
  await github.cli(repo, ['event', key, '--kind', 'resolve', '--by', 'user', '--body', option ? `选 ${option}：${words}` : words])
  github.boards.forget(repo)
  github.wrote.dispatchEvent(new Event(WROTE))
  return Response.json({ task: key, option: option ?? null, words, at: new Date().toISOString() }, { status: 201 })
}

async function write(team: Team, asThisPerson: (body: unknown) => Promise<Response>, github: Github, dir: string, path: string, query: URLSearchParams, request: Request) {
  const [what, ...rest] = path.split('/')
  if (what === 'answer' && request.method === 'POST' && rest.length === 1 && rest[0]) {
    const repo = await githubRepoOf(dir, query.get('project'))
    return repo ? answerOnGithub(github, repo, rest[0], request) : answer(team, asThisPerson, rest[0], request)
  }
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

export function site(
  team: Team,
  { dir, webToken, boardToken, port, dist = BUILT_PAGE, tailnet, pullStateOf = noPullStates, cli = oldCli }: { dir: string; webToken: string; boardToken: string; port: number; dist?: string; tailnet?: string; pullStateOf?: PullStateOf; cli?: OldCli },
) {
  const want = Buffer.from(webToken)
  const github: Github = { cli, boards: githubBoards(cli), wrote: new EventTarget() }
  const asThisPerson = (body: unknown) =>
    team.fetch(new Request(`${urlFor(port)}/messages`, { method: 'POST', headers: { authorization: `Bearer ${boardToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const inspect = inspector({ board: team, basePath: INSPECTOR })
  const inspectReadOnly = (request: Request, pathname: string) => {
    if (!READS.has(request.method)) return refuse(405, 'the inspector here is read-only: write through nawaban')
    if (pathname === INSPECTOR || pathname === INSPECTOR + '/') return new Response(null, { status: 302, headers: { location: INSPECTOR_OPENS_ON } })
    const apiPath = pathname === INSPECTOR_API ? '/' : pathname.startsWith(INSPECTOR_API + '/') ? pathname.slice(INSPECTOR_API.length) : null
    if (apiPath !== null && !NATIVE_GETS_THAT_ONLY_READ.test(apiPath)) return refuse(405, 'the inspector here is read-only: this read changes state')
    return inspect(request)
  }
  const theInspectorOpensForWhoeverTheApiAnswered = `${WEB_TOKEN_COOKIE}=${webToken}; Path=${INSPECTOR}; HttpOnly; SameSite=Strict`
  return async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url)
    if (pathname === '/api/board' || pathname.startsWith('/api/board/')) return team.fetch(request)
    const isApi = pathname.startsWith(API)
    const isInspector = pathname === INSPECTOR || pathname.startsWith(INSPECTOR + '/')
    const presented = isApi ? bearerOf(request) : isInspector ? webTokenCookieOf(request) : null
    const refusal =
      fromThisMachineOrTheTailnetElseRefusal(request, port, tailnet) ??
      (presented !== null ? (holdsTheWebTokenElseRefusal(presented, want) ?? writesOnlyFromThePagesOwnOriginElseRefusal(request, tailnet)) : null)
    if (refusal) return refusal
    if (isInspector) return inspectReadOnly(request, pathname)
    if (!isApi) return READS.has(request.method) ? builtFile(pathname, dist) : refuse(405, 'read-only')
    const path = pathname.slice(API.length)
    try {
      const answered = await (READS.has(request.method) ? view(team, dir, pullStateOf, github, path, searchParams, request.signal) : write(team, asThisPerson, github, dir, path, searchParams, request))
      answered.headers.append('set-cookie', theInspectorOpensForWhoeverTheApiAnswered)
      return answered
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

export async function webOverTailnet(dir = DIR): Promise<number> {
  const host = await tailnetHost(dir)
  if (host === undefined) {
    process.stderr.write(`没开 tailnet:把 tailscale 给这台机器的主机名写进 ${join(dir, TAILNET_HOST_FILE).replace(homedir(), '~')}，重启 nawaban serve，见 docs/install.md\n`)
    return 1
  }
  process.stdout.write(`https://${host}/#k=${await token(dir, WEB_TOKEN)}\n`)
  return 0
}

export async function serve(dir = DIR, port = PORT) {
  const url = urlFor(port)
  const tailnet = await tailnetHost(dir)
  const syncConfig = await githubSyncConfig(dir)
  const secret = syncConfig && (await webhookSecret(dir))
  if (syncConfig) globalThis.fetch = refusingGithubWrites(globalThis.fetch)
  const sync = syncConfig && secret ? { github: importOnlySync(syncConfig, await readerToken(syncConfig.reader), secret) } : undefined
  const team = board({ backend: local({ dir }), authenticate: verifier(await token(dir)), url, middleware: [impactNames(dir)], ...(sync ? { sync } : {}) })
  await registerSchemas(team)
  if (syncConfig && secret) {
    const reader = async () => ghReader(await readerToken(syncConfig.reader))
    const settleFor = (repo: string, channel: string) => (known: KnownIssue[]) => settleIssueTasks(team, channel, repo, known)
    pollForever(syncConfig, dir, reader, deliverAsSignedWebhook((request) => team.fetch(request), url, secret), settleFor, (line) => console.error(line))
  }
  const server = await listen(site(team, { dir, webToken: await token(dir, WEB_TOKEN), boardToken: await token(dir), port, tailnet, pullStateOf: pullStateFromGitHub }), port)
  const tailnetPage = tailnet ? ` and https://${tailnet}/ through tailscale serve` : ''
  console.log(`serving the board at ${url} and its page at http://127.0.0.1:${port}/${tailnetPage}, its log in ${dir.replace(homedir(), '~')}`)
  return server
}
