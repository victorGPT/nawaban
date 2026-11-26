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
import { markerOf, openIssuesWithoutAnOpenTask, settleIssueTasks } from '../src/github-tasks.ts'
import { pushRepo, writtenHereFirst, type Poster } from '../src/github-push.ts'
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
let commentsEverMade = 0
function commentOn(number: number, body: string) {
  const at = tick()
  world.comments.push({ id: 9000 + commentsEverMade++, body, user: yue, created_at: at, updated_at: at,
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
    expect(roots[0]!.text.split('\n')[0]).toBe('issue 1740')
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
    expect(roots[0]!.text.split('\n')[0]).toBe('issue 1750')
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

  it('切过去以后同步仓库的待决记在板上的票上，不再经旧 CLI 写 GitHub', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const card = {
      ticket: 'ROUBAO-1730', decision: '先合 A 还是先合 B', kr: '听得懂需求 / 意图准确率', context: 'A 改了接口',
      options: [{ choice: 'A', tradeoff: '快', door: 'two-way' }, { choice: 'B', tradeoff: '稳', door: 'one-way' }], recommendation: 'A',
    }
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1730' } })).tasks[0]!.message.id
    await writeFile(join(tmp, 'gh.log'), '')
    const r = await hook('ask-guard.sh', checkouts.roubao!, { stop_hook_active: false, last_assistant_message: `你定。\n\n${block('nawaban-ask-request@1', card)}\n` })
    expect([r.code, r.out, r.err]).toEqual([0, '', ''])
    expect(await readFile(join(tmp, 'gh.log'), 'utf8')).toBe('')
    const { ticket, ...asked } = card
    expect((await team.thread(id)).replies.flatMap((m) => m.blocks).filter((b) => b.schema === 'nawaban-ask').map((b) => b.data)).toEqual([asked])
  })
})

const impactSaidOnGithub = (body: string, more: Record<string, string> = {}) => `影响：${body}\n\n<!-- nawaban ${JSON.stringify({ v: 1, uid: `u-${world.comments.length}`, kind: 'impact', author: 'cc-x', terminal: null, at: 1, body, ...more }).replace(/-/g, '\\u002d')} -->`

describe('切过去以后板 CLI 是唯一写路径：每种写入经发件箱推到 GitHub 恰好一条', () => {
  it('ask、resolve、claim（带影响）、note、decision、link、release、close 各推一条，再推一轮不重发', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const config = join(dir, 'github-sync.json')
    const without = await readFile(config, 'utf8')
    await writeFile(config, JSON.stringify({ ...JSON.parse(without), push: [REPO] }))
    try {
      world.issues.push(issue(1795))
      await poll()
      const roubao = checkouts.roubao!
      const say = (...argv: string[]) => nawaban(roubao, ...argv)
      await say('event', 'ROUBAO-1795', 'ask', '先合哪个', '--kr', '听得懂需求 / 意图准确率', '--context', 'A 改了接口', '--option', 'A｜快｜双向门', '--option', 'B｜稳｜单向门', '--rec', 'A')
      await say('event', 'ROUBAO-1795', 'resolve', '选 A。吴献忠原话：「A」')
      await say('claim', 'ROUBAO-1795', '--o', '无')
      await say('event', 'ROUBAO-1795', 'note', '已完成：改完；下一步：开 PR')
      await say('event', 'ROUBAO-1795', 'decision', '决定：先合 A\n背景：两个都能合\n否决方案：先合 B')
      await say('event', 'ROUBAO-1795', 'link', `pr:https://github.com/${REPO}/pull/9`)
      await say('claim', 'ROUBAO-1795', '--release')
      await say('close', 'ROUBAO-1795', '--done')
      const posted: { issue: number; body: string }[] = []
      const states: string[] = []
      const assigned: boolean[] = []
      const poster: Poster = {
        login: 'wuxianzhong-gpt',
        userId: async () => 1,
        commentsSince: async () => posted.map((p, i) => ({ id: i + 1, body: p.body })),
        post: async (_repo, n, body) => (posted.push({ issue: n, body }), { id: posted.length, body }),
        assign: async (_repo, _n, yes) => void assigned.push(yes),
        setState: async (_repo, _n, wanted) => void states.push(wanted),
        openedSince: async () => [],
        open: async () => { throw new Error('不该开 issue') },
      }
      expect(await pushRepo(team, 'roubao', REPO, poster)).toEqual({ unpushed: 0 })
      const kinds = posted.map((p) => [p.issue, p.body.split('：')[0], markerOf(p.body)?.kind])
      expect(kinds).toEqual([
        [1795, '待决', 'ask'],
        [1795, '已决', 'resolve'],
        [1795, '认领', 'claim'],
        [1795, '影响', 'impact'],
        [1795, '进展', 'note'],
        [1795, '决定', 'decision'],
        [1795, 'PR', 'link'],
        [1795, '交还', 'release'],
      ])
      expect(posted[0]!.body).toContain('备选方案：\n- A｜快｜双向门\n- B｜稳｜单向门\n建议：A')
      expect(markerOf(posted[3]!.body)?.body).toBe('O 无')
      expect(posted[6]!.body.startsWith(`PR：https://github.com/${REPO}/pull/9\n`)).toBe(true)
      expect([assigned, states]).toEqual([[true, false], ['completed']])
      expect(await pushRepo(team, 'roubao', REPO, poster)).toEqual({ unpushed: 0 })
      expect([posted.length, states.length]).toEqual([8, 1])
      for (const p of posted) commentOn(1795, p.body)
      await poll()
      const thread = (await team.thread((await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1795' } })).tasks[0]!.message.id)).replies
      expect(thread.filter((r) => r.from === 'github' && markerOf(r.text))).toEqual([])
      await say('close', 'ROUBAO-1795', '--reopen')
      await pushRepo(team, 'roubao', REPO, poster)
      expect([posted.length, states]).toEqual([8, ['completed', 'open']])
    } finally {
      await writeFile(config, without)
    }
    const notPushed = await run(['node', CLI, 'close', 'ROUBAO-1795', '--reopen'], checkouts.roubao!)
    expect([notPushed.code, notPushed.err.split('\n')[0]]).toEqual([1, '✗ ROUBAO-1795 不是推到 GitHub 的 issue 票：板上的票关了不重开，要接着做就新开一张'])
  })
})

describe('切到板上后 roubao worker 照旧的写法', () => {
  it('切过去后用板上票号 ROUBAO-N：show、event、claim 都通，标题就是 issue 原标题，旧写法 #N 板不认', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1770))
    await poll()
    const roubao = checkouts.roubao!
    expect(await nawaban(roubao, 'show', 'ROUBAO-1770')).toMatch(/^ROUBAO-1770 +ready +issue 1770\n/)
    await nawaban(roubao, 'event', 'ROUBAO-1770', 'note', '用板上票号')
    await nawaban(roubao, 'claim', 'ROUBAO-1770', '--o', '无')
    const shown = await nawaban(roubao, 'show', 'ROUBAO-1770', '--all')
    expect(shown).toContain('用板上票号')
    expect(shown).toMatch(/holder\s+cc-aaaa1111/)
    const old = await run(['node', CLI, 'show', '#1770'], roubao)
    expect([old.code, old.err.split('\n')[0]]).toEqual([1, '✗ 没有票 #1770'])
  })

  it('GitHub 上改了标题，板上的票跟着换成新标题，不带 Issue #N 前缀', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const renamed = world.issues.find((i) => i.number === 1770)!
    Object.assign(renamed, { title: '换了名字', updated_at: tick() })
    await poll()
    expect(await nawaban(checkouts.roubao!, 'show', 'ROUBAO-1770')).toMatch(/^ROUBAO-1770 +\S+ +换了名字\n/)
  })

  it('带 Issue #N 前缀入站过的同步状态，下一轮给每个 open issue 补一次改标题，之后不再补', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const path = join(dir, 'github-sync', `${encodeURIComponent(REPO)}.json`)
    const { titledAsOnGithub, ...before } = JSON.parse(await readFile(path, 'utf8'))
    expect(titledAsOnGithub).toBe(true)
    await writeFile(path, JSON.stringify(before))
    const delivered: string[] = []
    const deliver = deliverAsSignedWebhook((request) => team.fetch(request), url, WEBHOOK)
    const counting: typeof deliver = async (event, payload) => {
      if (payload.action === 'edited' && event === 'issues') delivered.push(String((payload.issue as Issue).number))
      return deliver(event, payload)
    }
    await pollRepo(REPO, dir, reader, counting, clock)
    const open = Object.entries(before.issues as Record<string, { state: string }>).filter(([, s]) => s.state === 'open').map(([n]) => n)
    expect(delivered.sort()).toEqual(open.sort())
    delivered.length = 0
    await pollRepo(REPO, dir, reader, counting, clock)
    expect(delivered).toEqual([])
  })

  it('GitHub 上已记的影响入站成板上的声明，merge.sh 的影响闸放行，重跑不多一条', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1780), issue(1781))
    commentOn(1780, impactSaidOnGithub('O 听得懂需求 · 意图准确率=↑ 91→93 实测'))
    commentOn(1780, impactSaidOnGithub('O 无'))
    await poll()
    await poll()
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1780' } })).tasks[0]!.message.id
    const declared = (await team.thread(id)).replies.flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact').map((b) => b.data)
    expect(declared).toEqual([
      { objective: '听得懂需求', krs: [{ name: '意图准确率', dir: '↑', before: '91', after: '93', basis: '实测' }] },
      { objective: '无', krs: [] },
    ])
    await writeFile(join(tmp, 'pr.json'), JSON.stringify({ number: 8, title: 'fix: y', body: 'Closes #1780', headRefName: 'fix-y' }))
    const passed = await hook('board-impact-guard.sh', checkouts.roubao!, { tool_name: 'Bash', tool_input: { command: 'scripts/merge.sh 8' } })
    expect([passed.code, passed.out, passed.err]).toEqual([0, '', ''])
    await writeFile(join(tmp, 'pr.json'), JSON.stringify({ number: 9, title: 'fix: z', body: 'Closes #1781', headRefName: 'fix-z' }))
    const stopped = await hook('board-impact-guard.sh', checkouts.roubao!, { tool_name: 'Bash', tool_input: { command: 'scripts/merge.sh 9' } })
    expect(stopped.out + stopped.err).toContain('ROUBAO-1781')
    expect(githubWrites).toEqual([])
  })

  it('GitHub 上改了或删了影响评论，板上的声明跟着改、跟着撤，合并锁随之拦', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1782))
    commentOn(1782, impactSaidOnGithub('O 无'))
    await poll()
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1782' } })).tasks[0]!.message.id
    const declared = async () => (await team.thread(id)).replies.filter((r) => !r.deleted).flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact').map((b) => b.data)
    expect(await declared()).toEqual([{ objective: '无', krs: [] }])
    const said = world.comments.at(-1)!
    Object.assign(said, { body: impactSaidOnGithub('O 听得懂需求 · 意图准确率==') , updated_at: tick() })
    world.issues.find((i) => i.number === 1782)!.updated_at = said.updated_at as string
    await poll()
    expect(await declared()).toEqual([{ objective: '听得懂需求', krs: [{ name: '意图准确率', dir: '=' }] }])
    world.comments.splice(world.comments.indexOf(said), 1)
    const deliver = deliverAsSignedWebhook((request) => team.fetch(request), url, WEBHOOK)
    await deliver('issue_comment', { action: 'deleted', issue: world.issues.find((i) => i.number === 1782), comment: { ...said, body: '' }, repository: await reader.one(`repos/${REPO}`), sender: yue })
    await poll()
    expect(await declared()).toEqual([])
    expect(await mergeGateFor('Closes #1782')).toContain('ROUBAO-1782')
  })


  it('板上推出去的 toward|away|hold 影响，换一块板读回来是 v2 声明，带着 change', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1797))
    commentOn(1797, impactSaidOnGithub('O 听得懂需求 · 意图准确率=toward', { change: 'measure' }))
    await poll()
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1797' } })).tasks[0]!.message.id
    const declared = (await team.thread(id)).replies.flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact')
    expect(declared.map((b) => [b.version, b.data])).toEqual([[2, { objective: '听得懂需求', change: 'measure', krs: [{ name: '意图准确率', heading: 'toward' }] }]])
  })

  it('GitHub 上的待决被板上的 resolve 答了，下一轮结算不再挂起这张票', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1798))
    await poll()
    commentOn(1798, '待决：走 A 还是 B？')
    await poll()
    const held = async () => (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1798' } })).tasks[0]!.message.task?.blocked ?? null
    expect((await held())?.reason).toContain('GitHub 待决')
    await nawaban(checkouts.roubao!, 'event', 'ROUBAO-1798', 'resolve', '走 A')
    expect(await held()).toBeNull()
    await poll()
    expect(await held()).toBeNull()
    commentOn(1798, '待决：那 C 呢？')
    await poll()
    expect((await held())?.reason).toContain('那 C 呢？')
  })

  it('旧 CLI 写的影响里 KR 带尾随空白，照样读成声明', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1804))
    commentOn(1804, impactSaidOnGithub('O 听得懂需求 · 意图准确率==  · 意图准确率=↑ 91→93 实测 '))
    await poll()
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1804' } })).tasks[0]!.message.id
    const declared = (await team.thread(id)).replies.flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact').map((b) => b.data)
    expect(declared).toEqual([{ objective: '听得懂需求', krs: [{ name: '意图准确率', dir: '=' }, { name: '意图准确率', dir: '↑', before: '91', after: '93', basis: '实测' }] }])
  })

  it('重开过两次的票，前一张票上记的回复推出去以后读回来也认得是回声', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    const { task: root } = await team.tasks.create('roubao', { text: '原 issue', labels: { issue: `${REPO}#1799` } })
    const { task: first } = await team.tasks.create('roubao', { text: '第一次重开，key 已经交出去', labels: { 'issue-root': root.id } })
    await team.tasks.create('roubao', { text: '第二次重开', labels: { key: 'ROUBAO-1799', 'issue-root': root.id } })
    const said = await team.reply(first.id, { text: '进展一句', labels: { 'github-push': 'note' } })
    const echo = `进展：进展一句\n\n<!-- nawaban ${JSON.stringify({ v: 1, uid: said.id, kind: 'note', body: '进展一句' })} -->`
    expect(await writtenHereFirst(team, 'roubao', REPO, 1799, echo)).toBe(true)
  })

  it('影响评论先去掉 marker 再改回来，板上的声明先撤再补', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1802))
    commentOn(1802, impactSaidOnGithub('O 无'))
    await poll()
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1802' } })).tasks[0]!.message.id
    const declared = async () => (await team.thread(id)).replies.filter((r) => !r.deleted).flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact').length
    const said = world.comments.at(-1)!
    const edit = async (body: string) => {
      Object.assign(said, { body, updated_at: tick() })
      world.issues.find((i) => i.number === 1802)!.updated_at = said.updated_at as string
      await poll()
    }
    const counts = [await declared()]
    await edit('影响：随手写的，不算')
    counts.push(await declared())
    await edit(impactSaidOnGithub('O 无'))
    counts.push(await declared())
    expect(counts).toEqual([1, 0, 1])
  })

  it('GitHub 待决挂住的票在 GitHub 上关了又重开，板上在新票上答了，下一轮不再挂起', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1801))
    await poll()
    commentOn(1801, '待决：走 A 还是 B？')
    await poll()
    const it1801 = world.issues.find((i) => i.number === 1801)!
    Object.assign(it1801, { state: 'closed', state_reason: 'completed', updated_at: tick() })
    await poll()
    Object.assign(it1801, { state: 'open', state_reason: null, updated_at: tick() })
    await poll()
    const current = async () => (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1801' } })).tasks[0]!.message
    expect((await current()).labels['issue-root']).toBeDefined()
    expect((await current()).task?.blocked?.reason).toContain('GitHub 待决')
    await nawaban(checkouts.roubao!, 'event', 'ROUBAO-1801', 'resolve', '走 A')
    await poll()
    expect((await current()).task?.blocked ?? null).toBeNull()
  })

  it('升级前 hook 已经记过的影响，GitHub 上同一条评论入站时不再另记一份', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1805))
    await poll()
    const rows = [{ repo: checkouts.roubao!, ticket: '#1805', objective: '无', kr: '', dir: '=', before: null, after: null, basis: null, declared_at: '2026-11-24T12:00:00' }]
    expect((await run(['node', CLI, 'hook', 'github-impact'], checkouts.roubao!, JSON.stringify(rows))).code).toBe(0)
    commentOn(1805, impactSaidOnGithub('O 无'))
    await poll()
    const id = (await team.tasks.list({ state: 'all', label: { key: 'ROUBAO-1805' } })).tasks[0]!.message.id
    expect((await team.thread(id)).replies.filter((r) => !r.deleted).flatMap((r) => r.blocks).filter((b) => b.schema === 'nawaban-impact')).toHaveLength(1)
  })

  it('读不懂的影响评论让这一轮结算失败：没核对完就不切换', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
    world.issues.push(issue(1790))
    commentOn(1790, impactSaidOnGithub('O 听得懂需求 · 乱写'))
    const deliver = deliverAsSignedWebhook((request) => team.fetch(request), url, WEBHOOK)
    const settle = (known: Parameters<typeof settleIssueTasks>[3]) => settleIssueTasks(team, 'roubao', REPO, known)
    await expect(pollRepo(REPO, dir, reader, deliver, clock, settle).then(() => pollRepo(REPO, dir, reader, deliver, clock, settle))).rejects.toThrow('#1790：GitHub 上的影响评论读不懂：O 听得懂需求 · 乱写')
  })
})
