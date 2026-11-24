import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { registerSchemas } from '../src/schemas.ts'
import { defHash, judge, jsonOkr, keepEachNewReadingOnce, okr, run, type Declared, type KeptReading, type Kr, type Objective } from '../src/okr.ts'

const OKR_PORTED_FROM_THE_OLD_TEST_OKR_PY = `
[[objective]]
name = "听得懂需求"

[[objective.kr]]
name = "意图准确率"
target = ">= 95"
unit = "%"
measure = "echo '进度日志'; echo '100.0 2026-11-17'"

[[objective.kr]]
name = "L1 首位"
target = ">= 95"
unit = "%"
measure = "echo '89 2026-11-17'"

[[objective.kr]]
name = "边界难例"
target = ">= 80"

[[objective]]
name = "推荐能减少筛选"

[[objective.kr]]
name = "硬条件违反"
target = "<= 0"
measure = "echo 'missing data' >&2; exit 3"

[[objective.kr]]
name = "没写日期"
target = ">= 1"
measure = "echo 5"

[[objective.kr]]
name = "不是数"
target = ">= 1"
measure = "echo 'n/a 2026-11-17'"
`

type Team = ReturnType<typeof board>
let team: Team
beforeAll(async () => {
  team = board({ backend: local({ memory: true }) })
  await registerSchemas(team)
})

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString().trim()
const okrFile = (root: string) => join(root, 'docs/agents/okr.toml')

async function repo(text: string | Buffer = OKR_PORTED_FROM_THE_OLD_TEST_OKR_PY) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-okr-')))
  await mkdir(join(root, 'docs/agents'), { recursive: true })
  await writeFile(okrFile(root), text)
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'okr')
  return root
}
const write = (root: string, text: string | Buffer) => writeFile(okrFile(root), text)
const define = (root: string, krs: [string, string, string?][]) =>
  write(root, '[[objective]]\nname = "O"\n' + krs.map(([n, t, x = '']) => `[[objective.kr]]\nname = "${n}"\ntarget = "${t}"\n${x}\n`).join(''))
const line = (out: string, name: string) => out.split('\n').find((l) => l.includes(name)) ?? ''
const text = async (root: string, timeout?: number) => (await run(root, timeout)).text

type Project = { root: string; dir: string; name: string }
let projects = 0

async function projectOnItsOwnBoardWithItsOwnReposJson(text: string = OKR_PORTED_FROM_THE_OLD_TEST_OKR_PY): Promise<Project> {
  const root = await repo(text)
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-okr-board-'))
  const name = `p${++projects}`
  await writeFile(join(dir, 'repos.json'), JSON.stringify({ [name]: root }))
  return { root, dir, name }
}

async function capture(fn: () => Promise<number>) {
  let out = ''
  let err = ''
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true)),
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true)),
  ]
  try {
    return { code: await fn(), out, err }
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}
const nawabanOkr = (p: Project, ...argv: string[]) => capture(() => okr(argv, team, p.dir, { cwd: p.root }))
async function jokr(p: Project, ...argv: string[]) {
  const { code, out } = await capture(() => jsonOkr(argv, team, p.dir, p.root))
  return { code, data: JSON.parse(out) }
}

async function declareTicketMovesKrOfO(p: Project, ticket: string, kr: string, dir: string) {
  const { task } = await team.tasks.create(p.name, { text: ticket, labels: { key: ticket } })
  const numbers = dir === '=' ? {} : { before: '1', after: '2', basis: '预计' }
  await team.reply(task.id, block('nawaban-impact@1', { objective: 'O', krs: [{ name: kr, dir, ...numbers }] }))
}

const day = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('okr measures each KR and never narrates', () => {
  it('counts a KR as met only when its measured value meets the target', async () => {
    const out = await text(await repo())
    expect(out).toContain('听得懂需求 · 1/3 达标')
    expect(out).toContain('推荐能减少筛选 · 0/3 达标')
    expect(line(out, '意图准确率')).toMatch(/ · 绿 · /)
    expect(out).toContain('100.0% / 目标 >= 95%')
    expect(out).toContain('截至 11-17')
    expect(line(out, 'L1 首位')).toMatch(/ \/ 目标 .* · 偏差 -[\d.]+ .*· 红 · 截至 /)
    expect(out).toContain('89.0% / 目标 >= 95%')
  })

  it('calls no measure untested, and says why a broken one failed', async () => {
    const out = await text(await repo())
    expect(line(out, '边界难例')).toBe('  边界难例  未测 / 目标 >= 80')
    expect(line(out, '硬条件违反')).toMatch(/测量失败.*missing data/)
    expect(line(out, '没写日期')).toContain('测量失败')
    expect(line(out, '不是数')).toContain('测量失败')
  })

  it('names the error line of a crash, not the runtime footer', async () => {
    const root = await repo(`[[objective]]\nname = "O"\n[[objective.kr]]\nname = "崩"\ntarget = ">= 1"\nmeasure = '''printf '  at x\nError [ERR_MODULE_NOT_FOUND]: no pkg\n  at y\n\nNode.js v26\n' >&2; exit 1'''\n`)
    expect(line(await text(root), '崩')).toContain('ERR_MODULE_NOT_FOUND')
  })

  it('names the exception of a Python crash, not a traceback path', async () => {
    const root = await repo(`[[objective]]\nname = "O"\n[[objective.kr]]\nname = "崩"\ntarget = ">= 1"\nmeasure = '''python3 -c 'exec(compile("1/0", "errors.py", "exec"))' '''\n`)
    expect(line(await text(root), '崩')).toContain('ZeroDivisionError')
  })

  it('fails a slow measure instead of hanging', async () => {
    const root = await repo('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "慢"\ntarget = ">= 1"\nmeasure = "sleep 5"\n')
    expect(line(await text(root, 500), '慢')).toMatch(/测量失败.*超时/)
  })

  it("names the definitions' commit and flags uncommitted edits", async () => {
    const root = await repo()
    const head = git(root, 'rev-parse', '--short', 'HEAD')
    const first = (await text(root)).split('\n')[0]!
    expect(first).toContain(head)
    expect(first).not.toContain('未提交')
    await write(root, OKR_PORTED_FROM_THE_OLD_TEST_OKR_PY.replace('>= 95', '>= 90'))
    expect((await text(root)).split('\n')[0]).toContain('未提交')
  })

  it.each(['95', '=> 95', '>= abc', ''])('refuses the whole file for the target %j', async (target) => {
    await expect(run(await repo(OKR_PORTED_FROM_THE_OLD_TEST_OKR_PY.replace('target = ">= 80"', `target = "${target}"`)))).rejects.toThrow(/边界难例.*target/)
  })

  it('refuses a repository with no definitions', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-okr-')))
    git(root, 'init', '-q')
    await expect(run(root)).rejects.toThrow(/docs\/agents\/okr.toml/)
  })

  it('refuses a KR without a name, or with a numeric target', async () => {
    const root = await repo('[[objective]]\nname = "O"\n[[objective.kr]]\ntarget = ">= 95"\n')
    await expect(run(root)).rejects.toThrow(/没写 name/)
    await write(root, '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = 95\n')
    await expect(run(root)).rejects.toThrow(/target/)
  })

  it('fails only the KR whose measure prints bad bytes', async () => {
    const root = await repo(`[[objective]]\nname = "O"\n[[objective.kr]]\nname = "坏字节"\ntarget = ">= 1"\nmeasure = '''printf '\\377' '''\n[[objective.kr]]\nname = "好的"\ntarget = ">= 1"\nmeasure = "echo '2 today'"\n`)
    const out = await text(root)
    expect(line(out, '坏字节')).toContain('测量失败')
    expect(line(out, '好的')).toBe('  好的  2.0 / 目标 >= 1 · 偏差 +1.0 · 绿 · 截至 today')
  })

  it.each([
    Buffer.from([0xff]),
    'objective = 5\n',
    '[[objective]]\nname = "O"\nkr = [1]\n',
    '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = true\n',
    '[[objective]]\nname = "O"\n[[objective.kr]]\nname = 3\ntarget = ">= 1"\n',
    '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmax_age_days = 1' + '0'.repeat(5000) + '\n',
  ])('refuses a definitions file of the wrong shape (%#)', async (body) => {
    await expect(run(await repo(body))).rejects.toThrow(/okr\.toml/)
  })

  it('misses a reading just below the target, however many digits', async () => {
    const root = await repo(
      '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 9007199254740993"\nmeasure = "echo 9007199254740992 today"\n' +
        '[[objective.kr]]\nname = "J"\ntarget = ">= 1.0000000000000001"\nmeasure = "echo 1 today"\n',
    )
    expect(await text(root)).toContain('0/2 达标')
  })

  it('calls a reading older than max_age_days stale, not met', async () => {
    const root = await repo(
      '[[objective]]\nname = "O"\n' +
        `[[objective.kr]]\nname = "新"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo '5 ${day(2)} report.md'"\n` +
        `[[objective.kr]]\nname = "旧"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo '5 ${day(10)}'"\n` +
        `[[objective.kr]]\nname = "无日期"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo '5 latest'"\n`,
    )
    const out = await text(root)
    expect(out).toContain('1/3 达标')
    expect(line(out, '新')).toMatch(/ · 绿 · /)
    expect(line(out, '旧')).toMatch(/ · 黄 · 截至 .*测量过期/)
    expect(line(out, '无日期')).toContain('测量失败')
  })

  it.each(['-1', 'true', '"7"', '1.5', '1.0'])('refuses the file for max_age_days = %s', async (age) => {
    await expect(run(await repo(`[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmax_age_days = ${age}\n`))).rejects.toThrow(/max_age_days/)
  })

  it('never counts a reading with bad bytes or a compact date', async () => {
    const root = await repo(
      '[[objective]]\nname = "O"\n' +
        `[[objective.kr]]\nname = "坏截至"\ntarget = ">= 1"\nmeasure = '''printf '2 \\377' '''\n` +
        '[[objective.kr]]\nname = "紧凑日期"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo 2 $(date +%Y%m%d)"\n',
    )
    const out = await text(root)
    expect(out).toContain('0/2 达标')
    expect(line(out, '坏截至')).toContain('测量失败')
    expect(line(out, '紧凑日期')).toContain('测量失败')
  })

  it('refuses the file for a NUL in a measure', async () => {
    const tomlEscapeForNul = '\\' + 'u0000'
    await expect(run(await repo(`[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = "echo ${tomlEscapeForNul}"\n`))).rejects.toThrow(/measure/)
  })

  it('reads a reading in scientific notation', async () => {
    expect(await text(await repo('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = "> 0"\nmeasure = "echo 1e-05 today"\n'))).toContain('1/1 达标')
  })
})

async function readingsTheBoardKeepsKrValueAsOfSource(p: Project) {
  const out: string[][] = []
  for (const { message } of (await team.threads({ channel: `okr/${p.name}` })).threads) {
    for (const reply of (await team.thread(message.id)).replies) {
      for (const b of reply.blocks) if (b.schema === 'nawaban-kr-reading') out.push(['kr', 'value', 'as_of', 'source'].map((k) => (b.data as Record<string, string>)[k]!))
    }
  }
  return out.sort()
}

describe('readings kept on the board', () => {
  it('keeps each reading once, and none from a failed or untested measure', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    const first = await nawabanOkr(p)
    expect([first.code, first.err]).toEqual([0, ''])
    expect(first.out).toContain('读数新记 2 条')
    expect(await readingsTheBoardKeepsKrValueAsOfSource(p)).toEqual([
      ['L1 首位', '89', '2026-11-17', ''],
      ['意图准确率', '100.0', '2026-11-17', ''],
    ])
    expect((await nawabanOkr(p)).out).toContain('读数新记 0 条')
    expect(await readingsTheBoardKeepsKrValueAsOfSource(p)).toHaveLength(2)
  })

  it('keeps the as-of as the date and the source as the rest', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = "echo 3 2026-11-18 a/b.md"\n')
    await nawabanOkr(p)
    expect(await readingsTheBoardKeepsKrValueAsOfSource(p)).toEqual([['K', '3', '2026-11-18', 'a/b.md']])
  })

  it('keeps the readings of a worktree under its main checkout', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    const wt = join(p.root, '..', `${p.name}-wt-${Date.now()}`)
    git(p.root, 'worktree', 'add', '-q', wt)
    expect((await capture(() => okr([], team, p.dir, { cwd: wt }))).code).toBe(0)
    expect(await readingsTheBoardKeepsKrValueAsOfSource(p)).toHaveLength(2)
  })

  it('prints and keeps nothing for a repository the board has no project for', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    await writeFile(join(p.dir, 'repos.json'), '{}')
    const { code, out, err } = await nawabanOkr(p)
    expect(code).toBe(0)
    expect(out).toContain('1/3 达标')
    expect(err).toContain('读数没记')
    expect(await readingsTheBoardKeepsKrValueAsOfSource(p)).toEqual([])
  })

  it('reads json okr off the board and never runs a measure', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    await define(p.root, [['意图准确率', '>= 95', 'measure = "cat k.txt"'], ['边界难例', '>= 80']])
    await writeFile(join(p.root, 'k.txt'), '90 2026-11-10')
    await nawabanOkr(p)
    await writeFile(join(p.root, 'k.txt'), '97.5 2026-11-18')
    await nawabanOkr(p)
    await define(p.root, [['意图准确率', '>= 95', 'measure = "touch ran; echo 1 2026-11-19"'], ['边界难例', '>= 80']])
    const { code, data } = await jokr(p)
    expect(existsSync(join(p.root, 'ran'))).toBe(false)
    expect(code).toBe(0)
    expect(data.repo).toBe(p.root)
    expect(data.def_commit).toBe(git(p.root, 'rev-parse', '--short', 'HEAD'))
    const [k, untested] = data.objectives[0].krs
    expect([k.status, k.value, k.as_of, k.trend, k.missed_rounds]).toEqual(['met', 97.5, '2026-11-18', 'closer', 0])
    expect(k.history).toEqual([
      { value: 90, as_of: '2026-11-10' },
      { value: 97.5, as_of: '2026-11-18' },
    ])
    expect([k.target, k.target_op, k.target_value]).toEqual(['>= 95', '>=', 95])
    expect(untested.status).toBe('untested')
    expect([data.met, data.total]).toEqual([1, 2])
  })

  it('answers json okr in a repository with no okr.toml with a JSON error', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    const bare = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-okr-bare-')))
    git(bare, 'init', '-q')
    const { code, data } = await jokr(p, '--repo', bare)
    expect(code).toBe(1)
    expect(data.error).toContain('okr.toml')
  })
})

const objectives = (krs: [string, string, Partial<Kr>?][]): Objective[] => [{ name: 'O', kr: krs.map(([name, target, more]) => ({ name, target, ...more })) }]

const eachReadingItsOwnRoundASecondApartOldestFirst = (readings: Record<string, [number, string][]>, at = '2026-11-19T00:00:00'): KeptReading[] =>
  Object.entries(readings).flatMap(([kr, rs]) => rs.map(([v, as_of], i) => ({ kr, value: String(v), as_of, source: '', measured_at: `${at.slice(0, -2)}${String(i).padStart(2, '0')}`, def_hash: '' })))

const reading = (kr: string, value: number, at: string, as_of = at.slice(0, 10)): KeptReading => ({ kr, value: String(value), as_of, source: '', measured_at: at, def_hash: '' })

type Decl = { ticket: string; kr: string; dir: string; at: string }

const decl = (ticket: string, kr: string, dir: string, at: string): Decl => ({ ticket, kr, dir, at })

function judged(objs: Objective[], rows: KeptReading[], accepts: Record<string, string> = {}, declared: Decl[] = []) {
  const byKr = new Map<string, Declared[]>()
  for (const d of [...declared].sort((a, b) => (a.at < b.at ? -1 : 1))) {
    if (!d.kr) continue
    const k = `O\0${d.kr}`
    byKr.set(k, [...(byKr.get(k) ?? []), { ticket: d.ticket, dir: d.dir, before: null, after: null, basis: null, declared_at: d.at }])
  }
  return judge(objs, rows, new Map(Object.entries(accepts)), byKr, '/repo', 'abc1234')
}

const kinds = (data: ReturnType<typeof judge>) => data.attention.map((a) => [a.kind, a.kr])

type KrOut = { name: string; trend: string; status: string; missed_rounds: number; wait: string; mismatch: unknown[]; verdicts: unknown[]; impacts: { ticket: string }[]; interval: [number, number] | null }

const krOf = (data: ReturnType<typeof judge>, name: string) => (data.objectives[0]!.krs as unknown as KrOut[]).find((k) => k.name === name)!

describe("json okr's judgement on rows with their rounds given", () => {
  it.each([
    ['>= 95', [80, 85], 'closer'],
    ['>= 95', [85, 80], 'away'],
    ['>= 95', [80, 80], 'flat'],
    ['<= 5', [9, 7], 'closer'],
    ['<= 5', [7, 9], 'away'],
    ['== 0', [-3, 2], 'closer'],
    ['== 0', [2, -3], 'away'],
    ['== 0', [2, -2], 'flat'],
  ] as const)('trends toward the target %s: %j is %s', (target, values, trend) => {
    const data = judged(objectives([['K', target]]), eachReadingItsOwnRoundASecondApartOldestFirst({ K: values.map((v, i) => [v, `2026-11-1${i}`] as [number, string]) }))
    expect(krOf(data, 'K').trend).toBe(trend)
  })

  it('flags stuck: missed, and two rounds not closer', () => {
    const data = judged(objectives([['卡住', '>= 95'], ['在动', '>= 95'], ['刚动', '>= 95'], ['两条', '>= 95'], ['达标', '>= 95']]), eachReadingItsOwnRoundASecondApartOldestFirst({
      卡住: [[80, '2026-11-10'], [80, '2026-11-11'], [79, '2026-11-12']],
      在动: [[80, '2026-11-10'], [80, '2026-11-11'], [81, '2026-11-12']],
      刚动: [[80, '2026-11-10'], [81, '2026-11-11'], [81, '2026-11-12']],
      两条: [[80, '2026-11-10'], [80, '2026-11-11']],
      达标: [[96, '2026-11-10'], [96, '2026-11-11'], [96, '2026-11-12']],
    }))
    expect(kinds(data)).toEqual([['stuck', '卡住']])
    expect(data.attention[0]!.text).toBe('两轮没往目标走（>= 95），最近三次 80、80、79')
  })

  it('flags five: five missed rounds in a row', () => {
    const data = judged(objectives([['五轮', '>= 95'], ['四轮', '>= 95']]), eachReadingItsOwnRoundASecondApartOldestFirst({
      五轮: [[96, '2026-11-09'], ...[0, 1, 2, 3, 4].map((i) => [80 + i, `2026-11-1${i}`] as [number, string])],
      四轮: [[96, '2026-11-09'], ...[0, 1, 2, 3].map((i) => [80 + i, `2026-11-1${i}`] as [number, string])],
    }))
    expect(kinds(data)).toEqual([['five', '五轮']])
    expect(data.attention[0]!.text).toBe('连续 5 轮未达标（>= 95），最近三次 82、83、84')
    expect([krOf(data, '五轮').missed_rounds, krOf(data, '四轮').missed_rounds]).toEqual([5, 4])
  })

  it('still flags five once the latest reading has gone stale', () => {
    const data = judged(objectives([['K', '>= 95', { max_age_days: 7 }]]), eachReadingItsOwnRoundASecondApartOldestFirst({ K: [0, 1, 2, 3, 4].map((i) => [80 + i, `2020-01-1${i}`] as [number, string]) }))
    expect(krOf(data, 'K').status).toBe('stale')
    expect(kinds(data)).toEqual([['five', 'K']])
  })

  it('flags wait: a KR waiting on the decision-maker, with no measure', () => {
    const data = judged(objectives([['要批', '>= 1', { wait: '批读生产数据' }], ['有量', '>= 1', { wait: 'x', measure: 'echo 1 2026-11-18' }]]), [])
    expect(data.attention).toEqual([{ kind: 'wait', objective: 'O', kr: '要批', text: '批读生产数据' }])
    expect(krOf(data, '要批').wait).toBe('批读生产数据')
  })

  it('answers json okr with a JSON error for a wait that is not a string', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nwait = 3\n')
    const { code, data } = await jokr(p)
    expect(code).toBe(1)
    expect(data.error).toContain('wait')
  })

  it('flags accept when all met and never accepted, or missed since', () => {
    const objs = objectives([['K', '>= 1']])
    const rows = eachReadingItsOwnRoundASecondApartOldestFirst({ K: [[2, '2026-11-10']] }, '2026-11-10T00:00:00')
    expect(kinds(judged(objs, rows))).toEqual([['accept', null]])
    expect(judged(objs, rows)).toMatchObject({ attention: [{ kind: 'accept', text: 'O 全 ✓，待你验收（nawaban okr --accept）' }] })
    const accepts = { O: '2026-11-11T00:00:00' }
    const quiet = judged(objs, rows, accepts)
    expect([quiet.attention, quiet.objectives[0]!.accept_pending]).toEqual([[], false])
    const since = judged(objs, [...rows, ...eachReadingItsOwnRoundASecondApartOldestFirst({ K: [[0, '2026-11-12'], [3, '2026-11-13']] }, '2026-11-12T00:00:00')], accepts)
    expect([kinds(since), since.objectives[0]!.accept_pending]).toEqual([[['accept', null]], true])
  })

  it('does not flag accept while a KR is not met', () => {
    expect(judged(objectives([['K', '>= 1'], ['J', '>= 1']]), eachReadingItsOwnRoundASecondApartOldestFirst({ K: [[2, '2026-11-10']] })).attention).toEqual([])
  })

  it('refuses okr --accept unless the Objective is all met now, keeping the readings', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    const refused = await nawabanOkr(p, '--accept', '听得懂需求')
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('还没全 ✓')
    expect(await readingsTheBoardKeepsKrValueAsOfSource(p)).toHaveLength(2)
    expect((await nawabanOkr(p, '--accept', '没这个')).code).toBe(1)
    await define(p.root, [['K', '>= 1', 'measure = "echo 2 2026-11-18"']])
    expect((await nawabanOkr(p, '--accept', 'O')).code).toBe(0)
    const { data } = await jokr(p)
    expect(data.objectives[0].accept_pending).toBe(false)
  })

  it('judges a kept value in json okr as okr judged it', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    await define(p.root, [['等于', '== 1', 'measure = "echo 1.0000000000000001 2026-11-18"'], ['大数', '>= 9007199254740993', 'measure = "echo 9007199254740992 2026-11-18"']])
    expect((await nawabanOkr(p)).out).toContain('0/2 达标')
    expect((await jokr(p)).data.objectives[0].krs.map((k: KrOut) => k.status)).toEqual(['missed', 'missed'])
  })

  it('flags accept again for a miss right after an accept', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    for (const [value, d] of [[2, 18], [0, 19], [3, 20]] as const) {
      await define(p.root, [['K', '>= 1', `measure = "echo ${value} 2026-11-${d}"`]])
      expect((await nawabanOkr(p, ...(d === 18 ? ['--accept', 'O'] : []))).code).toBe(0)
    }
    expect(kinds((await jokr(p)).data)).toEqual([['accept', null]])
  })
})

describe('declarations against readings', () => {
  it('counts the declarations since each KR’s last round', () => {
    const beforeTheLastRoundNoLongerCounted = decl('#1', 'K', '↑', '2026-11-09T00:00:00')
    const onJWithNoReadingYetEveryDeclarationCounts = decl('#4', 'J', '↓', '2026-11-11T00:00:02')
    const objectiveOnlyNoKrNotInTheCounts = decl('#6', '', '=', '2026-11-11T00:00:03')
    const data = judged(objectives([['K', '>= 95'], ['J', '<= 5']]), [reading('K', 80, '2026-11-10T00:00:00')], {}, [
      beforeTheLastRoundNoLongerCounted,
      decl('#2', 'K', '↑', '2026-11-11T00:00:00'),
      decl('#3', 'K', '=', '2026-11-11T00:00:01'),
      onJWithNoReadingYetEveryDeclarationCounts,
      decl('#5', 'J', '↑', '2026-11-01T00:00:00'),
      objectiveOnlyNoKrNotInTheCounts,
    ])
    expect(data.objectives[0]!.impacts).toEqual({ '↑': 2, '↓': 1, '=': 1 })
    expect(krOf(data, 'K').impacts.map((i) => i.ticket)).toEqual(['#2', '#3'])
    expect(krOf(data, 'K').impacts[0]).toEqual({ ticket: '#2', dir: '↑', before: null, after: null, basis: null, at: '2026-11-11T00:00:00' })
    expect(krOf(data, 'J').impacts.map((i) => i.ticket)).toEqual(['#5', '#4'])
    expect(krOf(data, 'K').mismatch).toEqual([])
  })

  it.each([
    ['>= 95', 80, 80, '↑', 'toward', '未定'],
    ['>= 95', 80, 79, '↑', 'toward', '不符'],
    ['>= 95', 80, 85, '↑', 'toward', '符合'],
    ['<= 5', 9, 7, '↑', 'away', '不符'],
    ['<= 5', 7, 7, '↑', 'away', '未定'],
    ['== 0', 2, -1, '↑', 'toward', '符合'],
    ['== 0', 2, -3, '↑', 'toward', '不符'],
    ['>= 95', 80, 79, '=', 'hold', '不符'],
    ['>= 95', 80, 80, '=', 'hold', '符合'],
    ['>= 95', 80, 85, '=', 'hold', '符合'],
    ['<= 5', 7, 9, '↓', 'toward', '不符'],
    ['<= 5', 7, 6, '↓', 'toward', '符合'],
    ['<= 5', 7, 7, '↓', 'toward', '未定'],
  ] as const)('judges a declaration by the first round after it, exactly with no n: %s %d→%d declared %s reads %s, %s', (target, before, after, dir, declared, verdict) => {
    const data = judged(objectives([['K', target]]), [reading('K', before, '2026-11-10T00:00:00'), reading('K', after, '2026-11-12T00:00:00')], {}, [decl('#7', 'K', dir, '2026-11-11T00:00:00')])
    expect(krOf(data, 'K').verdicts).toEqual([{ ticket: '#7', declared, verdict }])
    expect(krOf(data, 'K').mismatch).toEqual(verdict === '不符' ? [{ ticket: '#7', dir }] : [])
    const pendingOnceARoundHasComeSince = krOf(data, 'K').impacts
    expect(pendingOnceARoundHasComeSince).toEqual([])
  })

  it('judges a declaration only by its first round, and never one with no round before it', () => {
    const objs = objectives([['K', '>= 95']])
    const declared = [decl('#1', 'K', '↑', '2026-11-09T00:00:00'), decl('#2', 'K', '↑', '2026-11-11T00:00:00')]
    const rows = [reading('K', 80, '2026-11-10T00:00:00'), reading('K', 70, '2026-11-12T00:00:00')]
    expect(krOf(judged(objs, rows, {}, declared), 'K').mismatch).toEqual([{ ticket: '#2', dir: '↑' }])
    expect(krOf(judged(objs, [...rows, reading('K', 60, '2026-11-13T00:00:00')], {}, declared), 'K').mismatch).toEqual([])
  })

  it('judges one round with several readings on its latest as-of', () => {
    const rows = [reading('K', 80, '2026-11-10T00:00:00', '2026-11-10'), reading('K', 90, '2026-11-12T00:00:00', '2026-11-12'), reading('K', 70, '2026-11-12T00:00:00', '2026-11-11')]
    expect(krOf(judged(objectives([['K', '>= 95']]), rows, {}, [decl('#7', 'K', '↑', '2026-11-11T00:00:00')]), 'K').mismatch).toEqual([])
  })

  it('gives no verdict without a new round', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    await define(p.root, [['K', '>= 95', 'measure = "echo 80 2026-11-10"']])
    await nawabanOkr(p)
    await declareTicketMovesKrOfO(p, '#7', 'K', '↑')
    const sameAsOfAgainKeepsNoReadingSoNoNewRound = () => nawabanOkr(p)
    await sameAsOfAgainKeepsNoReadingSoNoNewRound()
    const k = (await jokr(p)).data.objectives[0].krs[0]
    expect(k.mismatch).toEqual([])
    expect(k.impacts.map((i: { ticket: string }) => i.ticket)).toEqual(['#7'])
  })

  it('prints the counts and the mismatches after okr', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson()
    await define(p.root, [['K', '>= 95', 'measure = "cat k.txt"'], ['J', '>= 1']])
    await writeFile(join(p.root, 'k.txt'), '80 2026-11-10')
    await nawabanOkr(p)
    await declareTicketMovesKrOfO(p, '#7', 'K', '↑')
    await declareTicketMovesKrOfO(p, '#8', 'J', '↓')
    await writeFile(join(p.root, 'k.txt'), '79 2026-11-11')
    const { code, out } = await nawabanOkr(p)
    expect(code).toBe(0)
    expect(out).toContain('O O · 声明 ↑0 ↓1 =0')
    expect(out).toContain('预期不符 K：#7 声明 ↑')
  })

  it('orders a reading after an accept in the same millisecond by the board, not by the clock', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\n')
    const now = new Date('2026-11-21T00:00:00.000Z')
    vi.useFakeTimers({ now, toFake: ['Date'] })
    try {
      const keep = (value: string, as_of: string) => keepEachNewReadingOnce(team, p.name, [{ objective: 'O', kr: 'K', value, as_of, source: '' }])
      await keep('2', '2026-11-01')
      await team.post(`okr/${p.name}`, block('nawaban-okr-accept@1', { objective: 'O' }))
      await keep('0', '2026-11-02')
      await keep('3', '2026-11-03')
    } finally {
      vi.useRealTimers()
    }
    const { data } = await jokr(p)
    expect(data.last_measured_at).toBe(now.toISOString())
    expect(kinds(data)).toEqual([['accept', null]])
  })
})

describe('a reading is judged within the series of the measure it was read under', () => {
  const krOf = async (p: Project, name: string) => (await jokr(p)).data.objectives[0].krs.find((k: { name: string }) => k.name === name)

  it('keeps a value that comes back on the same as-of and shows the latest', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = "<= 3"\nmeasure = "cat k.txt"\n')
    for (const v of ['2.1', '3.4', '2.1']) {
      await writeFile(join(p.root, 'k.txt'), `${v} 2026-11-17 e3`)
      await nawabanOkr(p)
    }
    expect((await readingsTheBoardKeepsKrValueAsOfSource(p)).map((r) => r[1])).toEqual(['2.1', '2.1', '3.4'])
    const k = await krOf(p, 'K')
    expect([k.value, k.status, k.trend]).toEqual([2.1, 'met', 'closer'])
  })

  it('starts a new series from zero when the measure script changes', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = "<= 3"\nmeasure = "cat k.txt # e3.ts"\n')
    await writeFile(join(p.root, 'e3.ts'), 'v1')
    for (const v of ['12.9', '11.6']) {
      await writeFile(join(p.root, 'k.txt'), `${v} 2026-11-17 e3`)
      await nawabanOkr(p)
    }
    const old = await krOf(p, 'K')
    expect([old.series.version, old.trend, old.missed_rounds]).toEqual([1, 'closer', 2])
    await writeFile(join(p.root, 'e3.ts'), 'v2')
    await nawabanOkr(p)
    const k = await krOf(p, 'K')
    expect([k.value, k.trend, k.missed_rounds, k.mismatch, k.history]).toEqual([11.6, null, 1, [], [{ value: 11.6, as_of: '2026-11-17' }]])
    expect(k.series.version).toBe(2)
    expect(k.series.def_hash).not.toBe(old.series.def_hash)
  })

  it('reads 量不了 while the measure fails, and reads again once it does', async () => {
    const p = await projectOnItsOwnBoardWithItsOwnReposJson('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = "== 0"\nmeasure = "cat k.txt"\n')
    await writeFile(join(p.root, 'k.txt'), '0 2026-11-17 ci')
    await nawabanOkr(p)
    await rm(join(p.root, 'k.txt'))
    expect((await nawabanOkr(p)).out).toContain('K  量不了 / 目标 == 0 · 测量失败：退出码 1')
    const failed = await krOf(p, 'K')
    expect([failed.status, failed.value, failed.missed_rounds]).toEqual(['unmeasurable', 0, 0])
    expect(failed.failure).toMatch(/^退出码 1/)
    await writeFile(join(p.root, 'k.txt'), '0 2026-11-17 ci')
    await nawabanOkr(p)
    const k = await krOf(p, 'K')
    expect([k.status, k.failure, k.trend, k.history]).toEqual(['met', null, null, [{ value: 0, as_of: '2026-11-17' }]])
  })

  it('hashes a measure as the old CLI does', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-def-hash-')))
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'scripts', 'e3.ts'), "export const gold = 'v3'\n")
    await writeFile(join(root, 'evals.jsonl'), '{}\n')
    const kr = { name: '放错档（E3）', target: '<= 3', unit: '%', max_age_days: 14, measure: 'node scripts/e3.ts evals.jsonl ../x.ts /etc/hosts' }
    expect(await defHash(root, kr)).toBe('5383ad5b5354835d')
  })
})

describe('a measure that changes and fails at once', () => {
  it('hashes a quoted script and leaves the old series behind', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-def-hash-')))
    await writeFile(join(root, 'm.py'), 'v1')
    const kr = { name: 'K', target: '>= 1', measure: 'python "m.py"' }
    const before = await defHash(root, kr)
    await writeFile(join(root, 'm.py'), 'v2')
    expect(await defHash(root, kr)).not.toBe(before)
    const separated = { ...kr, measure: 'python3 m.py; echo' }
    const beforeSeparated = await defHash(root, separated)
    await writeFile(join(root, 'm.py'), 'v3')
    expect(await defHash(root, separated)).not.toBe(beforeSeparated)
    const back: KeptReading[] = [['3', 'A'], ['2', 'A'], ['', 'B'], ['1', 'A']].map(([value, def_hash], i) => ({ kr: 'K', value: value!, as_of: '2026-11-17', source: 's', measured_at: String(i), def_hash: def_hash! }))
    const k2 = judge(objectives([['K', '>= 5']]), back, new Map(), new Map(), '/r', null).objectives[0]!.krs[0] as Record<string, unknown>
    expect([(k2.series as { version: number }).version, k2.trend, k2.missed_rounds]).toEqual([3, null, 1])
    const rows: KeptReading[] = [
      ...['3', '2'].map((value, i) => ({ kr: 'K', value, as_of: '2026-11-17', source: 's', measured_at: `2026-11-25T00:00:0${i}`, def_hash: 'old' })),
      { kr: 'K', value: '', as_of: '', source: 'exit 1', measured_at: '2026-11-25T00:00:03', def_hash: 'new' },
    ]
    const k = judge(objectives([['K', '>= 5']]), rows, new Map(), new Map(), '/r', null).objectives[0]!.krs[0] as Record<string, unknown>
    expect([k.status, k.series, k.trend, k.missed_rounds, k.history]).toEqual(['unmeasurable', null, null, 0, []])
  })
})

const INPUTS_HASH = '053c677dcdb3c251'

describe('inputs a KR declares', () => {
  it('hash as the old CLI does, dotfiles and missing patterns alike', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'nawaban-inputs-')))
    for (const [path, text] of [['gold/a.jsonl', 'a'], ['gold/sub/b.jsonl', 'b'], ['gold/.h.jsonl', 'h'], ['gold/.hidden/x.jsonl', 'x'], ['cases.json', 'c'], ['gold/C.JSONL', 'C'], ['outside/o.jsonl', 'o']] as const) {
      await mkdir(join(root, path, '..'), { recursive: true })
      await writeFile(join(root, path), text)
    }
    await symlink(join(root, 'outside'), join(root, 'gold', 'out'))
    await writeFile(join(root, 'gold', '😀.jsonl'), 'e')
    expect(await defHash(root, { name: 'K', target: '<= 3', inputs: ['gold/**/*.jsonl', 'cases.json', 'missing/*.txt', 'gold/**/**/*.jsonl', 'gold/?.jsonl'] })).toBe(INPUTS_HASH)
    const before = await defHash(root, { name: 'K', target: '<= 3', inputs: ['gold/**/*.jsonl'] })
    await writeFile(join(root, 'gold/sub/b.jsonl'), 'b2')
    expect(await defHash(root, { name: 'K', target: '<= 3', inputs: ['gold/**/*.jsonl'] })).not.toBe(before)
  })

  it('refuses inputs that are not an array of paths', async () => {
    await expect(run(await repo('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\ninputs = "gold.jsonl"\n'))).rejects.toThrow(/inputs 要写成非空字符串的数组/)
  })

  it.each(['gold/{a,b}.jsonl', 'gold/[ab].jsonl', 'gold/!(x).jsonl', 'gold/../x.jsonl', './gold/a.jsonl'])('refuses %s, glob syntax the old CLI reads apart', async (pattern) => {
    await expect(run(await repo(`[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\ninputs = ['${pattern}']\n`))).rejects.toThrow(/只认 \*、\?、\*\* 通配/)
  })
})

describe('a proportion reading carries its n and judges against the noise of n items', () => {
  const sampled = (kr: string, value: number, at: string, n: number, aa?: number): KeptReading => ({ ...reading(kr, value, at), source: `n=${n}${aa ? ` aa=${aa}` : ''} e3` })
  const e3 = (rows: KeptReading[], before: string, after: string) => krOf(judgedWith(rows, before, after), 'E3')

  const judgedWith = (rows: KeptReading[], before: string, after: string) => {
    const byKr = new Map<string, Declared[]>([['O\0E3', [{ ticket: '#1509', dir: '↓', before, after, basis: '实测', declared_at: '2026-11-11T00:00:00' }]]])
    return judge([{ name: 'O', kr: [{ name: 'E3', target: '<= 3', unit: '%' }] }], rows, new Map(), byKr, '/r', null)
  }

  it('reads a <= KR going down by more than one item of 233 as on its word, and less as undecided', () => {
    const down3 = [sampled('E3', 7.7, '2026-11-10T00:00:00', 233), sampled('E3', 4.7, '2026-11-12T00:00:00', 233)]
    expect(e3(down3, '7.7%', '4.7%').verdicts).toEqual([{ ticket: '#1509', declared: 'toward', verdict: '符合' }])
    const downLessThanOneItem = [sampled('E3', 4.7, '2026-11-10T00:00:00', 233), sampled('E3', 4.4, '2026-11-12T00:00:00', 233)]
    expect(e3(downLessThanOneItem, '4.7', '4.4').verdicts).toEqual([{ ticket: '#1509', declared: 'toward', verdict: '未定' }])
  })

  it('makes a change clear twice the same-commit rerun spread when that is wider than one item', () => {
    const rows = [sampled('E3', 7.7, '2026-11-10T00:00:00', 233, 2), sampled('E3', 4.7, '2026-11-12T00:00:00', 233, 2)]
    expect(e3(rows, '7.7', '4.7').verdicts).toEqual([{ ticket: '#1509', declared: 'toward', verdict: '未定' }])
  })

  it('falls back to exact comparison for a reading with no n', () => {
    const rows = [reading('E3', 4.7, '2026-11-10T00:00:00'), reading('E3', 4.6, '2026-11-12T00:00:00')]
    expect(e3(rows, '4.7', '4.6').verdicts).toEqual([{ ticket: '#1509', declared: 'toward', verdict: '符合' }])
  })

  it('lights green only when the Wilson bound clears the target, and reads undecided with its interval when only the point does', () => {
    const intent = (value: number, n: number) => krOf(judged([{ name: 'O', kr: [{ name: 'K', target: '>= 95', unit: '%' }] }], [sampled('K', value, '2026-11-10T00:00:00', n)]), 'K')
    expect([intent(97.5, 40).status, intent(97.5, 40).interval]).toEqual(['undecided', [87.1, 99.6]])
    expect(intent(100, 80).status).toBe('met')
    expect(intent(90, 80).status).toBe('missed')
  })

  it('prints undecided with its interval in okr', async () => {
    const out = await text(await repo('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 95"\nunit = "%"\nmeasure = "echo 97.5 2026-11-18 n=40 cases"\n'))
    expect(out).toContain('97.5% / 目标 >= 95% · 偏差 +2.5 点 · 未定（区间 [87.1, 99.6]）')
    expect(out).toContain('0/1 达标')
  })
})

describe("V2-01's replay, as json okr now judges it", () => {
  const E3_DECLARED = [
    ['#1411', '21.6', '17.2', 268, true, null],
    ['#1413', '17.2%', '12.9%', 233, false, '符合'],
    ['#1427', '12.9', '11.6', 233, true, null],
    ['#1480', '11.6%', '7.7%', 233, true, null],
    ['#1509', '7.7%', '4.7%', 233, false, '符合'],
    ['#1512', '4.7%', '3.4%', 233, false, '符合'],
    ['#1511', '4.7%', '2.1%', 233, false, '符合'],
  ] as const
  it.each(E3_DECLARED)('E3 %s %s→%s reads as its one-item column did', (ticket, before, after, nBefore, newMeasure, verdict) => {
    const row = (value: string, at: string, n: number, def_hash: string): KeptReading => ({ kr: 'E3', value: value.replace('%', ''), as_of: '2026-11-17', source: `n=${n} e3`, measured_at: at, def_hash })
    const rows = [row(before, '2026-11-10T00:00:00', nBefore, 'v1'), row(after, '2026-11-12T00:00:00', 233, newMeasure ? 'v2' : 'v1')]
    const declared = new Map<string, Declared[]>([['O\0E3', [{ ticket, dir: '↓', before, after, basis: '实测', declared_at: '2026-11-11T00:00:00' }]]])
    const k = krOf(judge([{ name: 'O', kr: [{ name: 'E3', target: '<= 3', unit: '%' }] }], rows, new Map(), declared, '/r', null), 'E3')
    expect(k.verdicts).toEqual(verdict ? [{ ticket, declared: 'toward', verdict }] : [])
  })
})
