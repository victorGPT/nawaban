import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { deliverAsSignedWebhook, importOnlySync, pollRepo, recordRound, refusingGithubWrites, switchOnceEveryOpenIssueHasATask, type Reader } from '../src/github-sync.ts'
import { openIssuesWithoutAnOpenTask, settleIssueTasks } from '../src/github-tasks.ts'
import { mergeGate } from '../src/impact.ts'
import { importOld } from '../src/import.ts'
import { oldRowsAsDeclaration } from '../src/github-impact.ts'
import { load } from '../src/okr.ts'
import { editingAsTheRootsAuthor, listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const HOOKS = join(ROOT, 'hooks')
const CLI = join(ROOT, 'board/src/cli.ts')
const REPO = 'acme/roubao'
const SECRET = 'test-secret'
const WEBHOOK = 'webhook-secret'
const SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const EVERY_STEP_STARTS_A_NODE_OR_A_SHELL = { timeout: 120_000 }
const OKR = '[[objective]]\nname = "听得懂需求"\n\n[[objective.kr]]\nname = "意图准确率"\ntarget = ">= 95"\n'
const yue = { id: 42, login: 'yuebutong', type: 'User' }
const sh = promisify(execFile)

type Issue = Record<string, unknown> & { number: number; state: string; updated_at: string }
const world: { issues: Issue[]; comments: Record<string, unknown>[] } = { issues: [], comments: [] }
let clock = Date.parse('2026-11-24T10:00:00Z')
const tick = () => new Date((clock += 60_000)).toISOString().replace('.000', '')
const issue = (number: number): Issue => ({
  id: 5000 + number, number, title: `issue ${number}`, body: 'x', state: 'open', user: yue, labels: [], assignees: [],
  html_url: `https://github.com/${REPO}/issues/${number}`, created_at: '2026-11-24T00:00:00Z', updated_at: tick(),
})
function commentOn(number: number, body: string) {
  const at = tick()
  world.comments.push({ id: 9000 + world.comments.length, body, user: yue, created_at: at, updated_at: at,
    html_url: `https://github.com/${REPO}/issues/${number}#c`, issue_url: `https://api.github.com/repos/${REPO}/issues/${number}` })
  world.issues.find((i) => i.number === number)!.updated_at = at
}
const reader: Reader = {
  list: async (path) => {
    const n = /issues\/(\d+)\/comments/.exec(path)?.[1]
    if (n) return world.comments.filter((c) => (c.issue_url as string).endsWith(`/${n}`))
    return path.includes('/issues/comments') ? world.comments : world.issues
  },
  one: async (path) => {
    const n = Number(/issues\/(\d+)$/.exec(path)?.[1])
    return n ? world.issues.find((i) => i.number === n) : { id: 7, name: 'roubao', full_name: REPO, owner: { login: 'acme', id: 9 } }
  },
  now: async () => new Date(clock + 60_000).toISOString(),
}

let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let env: Record<string, string> = {}
let tmp = ''
let dir = ''
let url = ''
const checkouts: Record<string, string> = {}
const githubWrites: string[] = []

beforeAll(async () => {
  globalThis.fetch = refusingGithubWrites(async (input, init) => {
    const request = new Request(input, init)
    if (request.method !== 'GET') githubWrites.push(`${request.method} ${request.url}`)
    return new Response('{}', { status: 404 })
  })
  server = await listen((request) => team.fetch(request), 0)
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  const sync = { github: importOnlySync({ repos: { [REPO]: 'roubao' }, reader: 'x' }, 'ghp_test', WEBHOOK) }
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url, sync })
  await registerSchemas(team)
  tmp = await mkdtemp(join(tmpdir(), 'nawaban-synced-'))
  await mkdir(join(tmp, 'bin'))
  await writeFile(join(tmp, 'bin/hc'), `#!/bin/sh\necho "{\\"labels\\":{\\"role\\":\\"orchestrator\\"},\\"pid\\":${process.pid}}"\n`)
  await writeFile(join(tmp, 'bin/gh'), `#!/bin/sh\necho "$(pwd) $@" >> ${tmp}/gh.log\nif [ "$1 $2" = "pr view" ]; then cat ${tmp}/pr.json; exit 0; fi\necho gh down >&2\nexit 1\n`)
  await Promise.all(['hc', 'gh'].map((b) => chmod(join(tmp, 'bin', b), 0o755)))
  for (const project of ['nawaban', 'roubao']) {
    const checkout = join(tmp, project)
    await mkdir(join(checkout, 'docs/agents'), { recursive: true })
    await writeFile(join(checkout, 'docs/agents/orchestrator.md'), '规矩正文\n')
    await sh('git', ['init', '-q', '-b', 'main', checkout])
    checkouts[project] = checkout
  }
  await writeFile(join(checkouts.roubao!, 'docs/agents/issue-tracker.md'), '# Issue tracker: GitHub\n')
  await writeFile(join(checkouts.roubao!, 'docs/agents/okr.toml'), OKR)
  dir = join(tmp, 'board')
  await mkdir(dir)
  await writeFile(join(dir, 'repos.json'), JSON.stringify(checkouts))
  await writeFile(join(dir, 'github-sync.json'), JSON.stringify({ repos: { [REPO]: 'roubao' }, reader: 'x' }))
  env = {
    PATH: `${join(tmp, 'bin')}:${process.env.PATH}`,
    HOME: tmp,
    BOARD_URL: url,
    BOARD_TOKEN: SECRET,
    NAWABAN_BOARD_DIR: dir,
    XDG_CONFIG_HOME: join(tmp, 'config'),
    CLAUDE_CODE_SESSION_ID: SESSION,
    HC_TERMINAL_ID: 't1',
  }
  world.issues.push(issue(1730))
  await poll()
})
afterAll(() => server.close())

async function poll() {
  const deliver = deliverAsSignedWebhook((request) => team.fetch(request), url, WEBHOOK)
  for (let round = 0; round < 2; round++) {
    await pollRepo(REPO, dir, reader, deliver, clock, (known) => settleIssueTasks(team, 'roubao', REPO, known, editingAsTheRootsAuthor(team, url, SECRET, 'victor')))
    await recordRound(dir, REPO)
    await switchOnceEveryOpenIssueHasATask(dir, REPO, (issues) => openIssuesWithoutAnOpenTask(team, 'roubao', issues))
    await new Promise((done) => setTimeout(done, 300))
  }
}

function run(what: string[], cwd: string, input = '') {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile(what[0]!, what.slice(1), { cwd, env }, (error, out, err) => resolve({ code: error ? Number(error.code) : 0, out, err }))
    child.stdin!.end(input)
  })
}
const hook = (name: string, checkout: string, input: Record<string, unknown> = {}) => run(['sh', join(HOOKS, name)], checkout, JSON.stringify({ session_id: SESSION, cwd: checkout, ...input }))
const nawaban = async (checkout: string, ...argv: string[]) => {
  const r = await run(['node', CLI, ...argv], checkout)
  expect(r.code, `${argv.join(' ')}: ${r.err}`).toBe(0)
  return r.out
}
async function pendingLine(checkout: string, session: string) {
  const r = await hook('inbox.sh', checkout, { session_id: session, stop_hook_active: false })
  expect(r.code, r.err).toBe(0)
  return r.out.trim() ? (JSON.parse(r.out).systemMessage as string) : null
}

const orchestratorScenarios = [
  {
    project: 'nawaban',
    key: 'NW-1',
    raise: async () => {
      await nawaban(checkouts.nawaban!, 'create', 'NW-1', '--title', '要密钥', '--project', 'nawaban')
      await nawaban(checkouts.nawaban!, 'event', 'NW-1', 'wait', '给密钥')
    },
    settle: () => nawaban(checkouts.nawaban!, 'event', 'NW-1', 'resolve', '给了'),
  },
  {
    project: 'roubao',
    key: 'ROUBAO-1730',
    raise: async () => {
      commentOn(1730, '待决：片源接入走哪条？')
      await poll()
    },
    settle: async () => {
      commentOn(1730, '已决：走 A')
      await poll()
    },
  },
]

describe('编排者窗口：GitHub 同步仓库和板上项目结果相同', () => {
  for (const { project, key, raise, settle } of orchestratorScenarios) {
    it(`${project}：开工打出索引，记一件待决后提示行列出它，再一轮说无变化，答了以后归零`, EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
      const checkout = checkouts[project]!
      expect((await run(['node', join(HOOKS, 'route.mjs'), checkout], checkout)).out).toBe(`board ${project}\n`)
      const start = await hook('leader-index.sh', checkout)
      expect(start.code, start.err).toBe(0)
      expect(start.out).toContain(`${project} 进行中的事`)
      expect(start.out).toContain('规矩正文')
      const session = `s-${project}`
      expect(await pendingLine(checkout, session)).toBe('待决 0 件')
      expect(await pendingLine(checkout, session)).toBeNull()

      await raise()
      expect(await pendingLine(checkout, session)).toMatch(new RegExp(`^待决 1 件：${key} \\S.*｜说「同步」看待决$`))
      expect(await pendingLine(checkout, session)).toBe('待决 1 件（无变化）')
      expect((await hook('leader-index.sh', checkout)).out).toContain(key)

      await settle()
      expect(await pendingLine(checkout, session)).toBe('待决 0 件')
      expect(githubWrites).toEqual([])
    })
  }
})

function oldDbWithRoubaoOkr(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT, parent TEXT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', session TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE blockers (task TEXT NOT NULL, blocker TEXT NOT NULL, PRIMARY KEY (task, blocker));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, at INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE kr_readings (repo TEXT NOT NULL, kr TEXT NOT NULL, value TEXT NOT NULL, as_of TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', measured_at TEXT NOT NULL, def_hash TEXT);
    CREATE TABLE okr_accepts (repo TEXT NOT NULL, objective TEXT NOT NULL, accepted_at TEXT NOT NULL);
    CREATE TABLE kr_impacts (repo TEXT NOT NULL, ticket TEXT NOT NULL, objective TEXT NOT NULL, kr TEXT NOT NULL DEFAULT '', dir TEXT NOT NULL, before TEXT, after TEXT, basis TEXT, declared_at TEXT NOT NULL);
  `)
  const roubao = checkouts.roubao!
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('ROUBAO-OLD-1', 'roubao', null, '旧板上的票', '', 'open', null, 1)
  const reading = db.prepare('INSERT INTO kr_readings VALUES (?, ?, ?, ?, ?, ?, ?)')
  reading.run(roubao, '意图准确率', '91', '2026-11-01', 'run a', '2026-11-01T10:00:00', null)
  reading.run(roubao, '意图准确率', '93', '2026-11-02', 'run b', '2026-11-02T10:00:00', 'def-1')
  reading.run(roubao, '意图准确率', '', '2026-11-03', 'measure 跑挂了', '2026-11-03T10:00:00', 'def-1')
  db.prepare('INSERT INTO okr_accepts VALUES (?, ?, ?)').run(roubao, '听得懂需求', '2026-11-03T10:00:00')
  const impact = db.prepare('INSERT INTO kr_impacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  impact.run(roubao, '#1740', '听得懂需求', '意图准确率', '↑', '91', '93', '实测', '2026-11-04T10:00:00')
  impact.run(roubao, '#5', '听得懂需求', '意图准确率', '=', null, null, null, '2026-11-04T11:00:00')
  impact.run(roubao, '#6', '无', '', '=', null, null, null, '2026-11-04T12:00:00')
  db.close()
}

async function importRoubaoOkr(from: string) {
  let out = ''
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true))
  try {
    const code = await importOld(['--from', from, '--project', 'roubao', '--okr-only', '--repos', join(tmp, 'none.md')], team, dir)
    return { code, out }
  } finally {
    write.mockRestore()
  }
}

async function mergeGateFor(body: string) {
  await writeFile(join(tmp, 'pr.json'), JSON.stringify({ number: 7, title: 'feat: x', body, headRefName: 'feat-x' }))
  const path = process.env.PATH
  process.env.PATH = env.PATH
  try {
    return await mergeGate('gh pr merge 7', checkouts.roubao!, team, dir)
  } finally {
    process.env.PATH = path
  }
}

describe('roubao 的 OKR 搬上板', () => {
  it('三张表条数一致，重跑不新增，旧板的票不带过来', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const old = join(tmp, 'nawaban.db')
    oldDbWithRoubaoOkr(old)
    const first = await importRoubaoOkr(old)
    expect(first.code, first.out).toBe(0)
    expect(first.out).toMatch(/readings\s+new 3, already there 0/)
    expect(first.out).toMatch(/roubao\s+kr_readings\s+3\s+3\n/)
    expect(first.out).toMatch(/accepts\s+new 1, already there 0/)
    expect(first.out).toMatch(/impacts\s+new 3, already there 0/)
    expect(first.out).toMatch(/roubao\s+kr_impacts\s+3\s+3\n/)
    expect(first.out).toContain('✓ the board agrees with the old one')
    const again = await importRoubaoOkr(old)
    expect(again.code, again.out).toBe(0)
    for (const what of ['tasks', 'readings', 'accepts', 'impacts']) expect(again.out).toMatch(new RegExp(`${what}\\s+new 0`))
    expect((await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-OLD-1' } })).tasks).toEqual([])
  })

  it('还没拉到的 issue 先挂占位线程，轮询拉到后同一条线程变成票、换上标题，声明还在上面', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1740))
    await poll()
    const { messages } = await team.channel('roubao').messages()
    const roots = messages.filter((m) => m.labels.issue === `${REPO}#1740`)
    expect(roots).toHaveLength(1)
    expect(roots[0]!.labels).toMatchObject({ key: 'ROUBAO-1740' })
    expect(roots[0]!.labels['title-awaits-github']).toBeUndefined()
    expect(roots[0]!.text.split('\n')[0]).toBe('Issue #1740: issue 1740')
    expect(roots[0]!.task?.state).toBe('ready')
    const { replies } = await team.thread(roots[0]!.id)
    expect(replies.flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact').map((b) => b.data)).toEqual([
      { objective: '听得懂需求', krs: [{ name: '意图准确率', dir: '↑', before: '91', after: '93', basis: '实测' }] },
    ])
  })

  it('永远拉不到的旧 issue 只留占位线程：不进票的列表，OKR 照样读到它的声明', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    expect(await nawaban(checkouts.roubao!, 'list', '--project', 'roubao')).not.toContain('ROUBAO-5')
    const { declared } = await load(team, 'roubao')
    expect([...declared.values()].flat().map((d) => d.ticket).sort()).toEqual(['ROUBAO-1740', 'ROUBAO-5'])
    expect(githubWrites).toEqual([])
  })

  it('旧 CLI 以本机用户的身份挂的占位线程，轮询拉到后照样换上标题，这一轮结算成', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const rows = [{ repo: checkouts.roubao!, ticket: '#1750', objective: '听得懂需求', kr: '意图准确率', dir: '=', before: null, after: null, basis: null, declared_at: '2026-11-24T11:30:00' }]
    const hooked = await run(['node', CLI, 'hook', 'github-impact'], checkouts.roubao!, JSON.stringify(rows))
    expect([hooked.code, hooked.err]).toEqual([0, ''])
    world.issues.push(issue(1750))
    await poll()
    const roots = (await team.channel('roubao').messages()).messages.filter((m) => m.labels.issue === `${REPO}#1750`)
    expect(roots).toHaveLength(1)
    expect(roots[0]!.by.principal).toBe('local:user:victor')
    expect(roots[0]!.text.split('\n')[0]).toBe('Issue #1750: issue 1750')
    expect(roots[0]!.labels['title-awaits-github']).toBeUndefined()
    expect(roots[0]!.task?.state).toBe('ready')
  })
})

describe('同步仓库的合并锁、旧 CLI 的声明、待决', () => {
  it('板上的合并锁认 Closes #N，在 issue 线程上找声明', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    expect(await mergeGateFor('Closes #1740')).toBeNull()
    expect(await mergeGateFor('Closes #1730')).toContain('ROUBAO-1730')
    expect(await mergeGateFor('Closes #17300')).toContain('没写到项目 roubao 的任何一张票')
  })

  it('GitHub 上重开过的票，声明在新票或原 issue 线程上都算', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const { task: finishedBeforeTheReopenKeptItsIssueButNotItsKey } = await team.tasks.create('roubao', { text: 'Issue #1760: 重开过\nx', labels: { issue: `${REPO}#1760`, state: 'open' } })
    const root = finishedBeforeTheReopenKeptItsIssueButNotItsKey
    const { task } = await team.tasks.create('roubao', { text: '重开过（GitHub 上重开）', labels: { key: 'ROUBAO-1760', 'issue-root': root.id } })
    expect(await mergeGateFor('Closes #1760')).toContain('ROUBAO-1760')
    const declaration = oldRowsAsDeclaration([{ repo: checkouts.roubao!, ticket: '#1760', objective: '无', kr: '', dir: '=', before: null, after: null, basis: null, declared_at: 'x' }])
    await team.reply(task.id, { text: declaration })
    expect(await mergeGateFor('Closes #1760')).toBeNull()
  })

  it('旧 CLI 在 #N 上声明的影响经 hook 记到同一条线程，重记不多一条，合并锁随即放行', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const rows = [{ repo: checkouts.roubao!, ticket: '#1730', objective: '听得懂需求', kr: '意图准确率', dir: '=', before: null, after: null, basis: null, declared_at: '2026-11-24T10:30:00' }]
    const first = await run(['node', CLI, 'hook', 'github-impact'], checkouts.roubao!, JSON.stringify(rows))
    expect([first.code, first.out]).toEqual([0, `✓ 影响声明记在板上（${REPO}#1730）\n`])
    const again = await run(['node', CLI, 'hook', 'github-impact'], checkouts.roubao!, JSON.stringify(rows))
    expect([again.code, again.out]).toEqual([0, `✓ 影响声明板上已有（${REPO}#1730）\n`])
    expect(await mergeGateFor('Closes #1730')).toBeNull()
    const notSynced = await run(['node', CLI, 'hook', 'github-impact'], checkouts.nawaban!, JSON.stringify([{ ...rows[0], repo: checkouts.nawaban! }]))
    expect([notSynced.code, notSynced.err]).toEqual([1, '✗ nawaban 不在本机 github-sync.json 的 repos 里：板上不记它的 GitHub 声明\n'])
    expect(githubWrites).toEqual([])
  })

  it('同步仓库的待决请求按 #N 交给旧 CLI，在该票所在的仓库里写到 GitHub，不记在板上', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const card = {
      ticket: 'ROUBAO-1730', decision: '先合 A 还是先合 B', kr: '听得懂需求 / 意图准确率', context: 'A 改了接口',
      options: [{ choice: 'A', tradeoff: '快', door: 'two-way' }, { choice: 'B', tradeoff: '稳', door: 'one-way' }], recommendation: 'A',
    }
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1730' } })).tasks[0]!.message.id
    const before = (await team.thread(id)).replies.length
    await writeFile(join(tmp, 'gh.log'), '')
    for (const session of [checkouts.roubao!, checkouts.nawaban!]) {
      await writeFile(join(tmp, 'gh.log'), '')
      const r = await hook('ask-guard.sh', session, { stop_hook_active: false, last_assistant_message: `你定。\n\n${block('nawaban-ask-request@1', card)}\n` })
      expect(r.code, r.err).toBe(0)
      const calls = (await readFile(join(tmp, 'gh.log'), 'utf8')).trim().split('\n')
      expect(calls.length).toBeGreaterThan(0)
      for (const call of calls) expect(call.startsWith(`${await realpath(checkouts.roubao!)} `) || call.startsWith(`${checkouts.roubao!} `), call).toBe(true)
      expect(calls.some((call) => /\b1730\b/.test(call))).toBe(true)
    }
    expect((await team.thread(id)).replies).toHaveLength(before)
  })
})
