import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { block, BoardError, type board, type MessageView } from '@vercel/board'
import { parse } from 'smol-toml'
import { OKR_FILE, projectOf } from './impact.ts'
import { Refused } from './tasks.ts'

/**
 * OKR progress, ported from the old nawaban/cli.py (okr_run, okr_record, okr_data): each KR's measure
 * runs here, its reading lands on the board in okr/<project>, one thread per KR, and json okr judges
 * what the board holds against the okr.toml as it is now. A reading's round, an accept's time, and a
 * declaration's time are all their message's createdAt, so they read off one clock.
 */
type Team = ReturnType<typeof board>
export type Kr = { name: string; target: string; unit?: string; measure?: string; wait?: string; max_age_days?: number }
export type Objective = { name: string; kr?: Kr[] }
/** A kept reading: its value as measured, verbatim, and when it was kept (its round). */
export type Row = { kr: string; value: string; as_of: string; source: string; measured_at: string }
export type Declared = { ticket: string; dir: string; before: string | null; after: string | null; basis: string | null; declared_at: string }

export const MEASURE_TIMEOUT = 60_000 // a measure reads results already produced, it never runs an eval
const TARGET = /^(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/
const READING = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+(\S.*)$/
const AS_OF = /^(\d{4}-\d\d-\d\d\S*)\s*(.*)$/s
const ERR_HEAD = /^\s*[\w.]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:/
const LINES = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u{2028}\u{2029}]/u
const REPLACED = '\u{fffd}'
const exec = promisify(execFile)

// Decimals compared exactly, as the old CLI's Decimal did: a float meets ">= 9007199254740993" with 9007199254740992.
type Dec = { n: bigint; e: number }
export function dec(s: string): Dec {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(s.trim())
  const e = Number(m?.[4] ?? 0) - (m?.[3] ?? '').length
  // ponytail: an exponent past 1000 isn't a KR reading; refusing it keeps 10n ** e cheap.
  if (!m || Math.abs(e) > 1000) throw new Refused(`不是数值:${s}`)
  return { n: BigInt(m[1]! + m[2]! + (m[3] ?? '')), e }
}
const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const e = Math.min(a.e, b.e)
  return [a.n * 10n ** BigInt(a.e - e), b.n * 10n ** BigInt(b.e - e), e]
}
const cmp = (a: Dec, b: Dec) => {
  const [x, y] = align(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}
const meets = (op: string, v: Dec, goal: Dec) => {
  const c = cmp(v, goal)
  return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0
}
/** Whether cur is closer to the target than prev: >= and > want more, <= and < less, == the nearer. */
function closer(op: string, goal: Dec, prev: Dec, cur: Dec) {
  const dist = (v: Dec): Dec => {
    if (op === '>=' || op === '>') return { n: -v.n, e: v.e }
    if (op === '<=' || op === '<') return v
    const [x, y, e] = align(v, goal)
    return { n: x > y ? x - y : y - x, e }
  }
  const c = cmp(dist(cur), dist(prev))
  return c < 0 ? 'closer' : c > 0 ? 'away' : 'flat'
}
const target = (kr: Kr) => TARGET.exec(kr.target.trim())!.slice(1) as [string, string]

const plain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x) && !(x instanceof Date)

/** The Objectives of root's okr.toml, checked; a malformed file is refused whole, never a KR skipped. */
export async function defs(root: string): Promise<Objective[]> {
  let bytes
  try {
    bytes = await readFile(join(root, OKR_FILE))
  } catch {
    throw new Refused(`没有 ${OKR_FILE}:KR 定义写在仓库里,O 由决策者定、KR 由决策者点头`)
  }
  let doc
  try {
    doc = parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { integersAsBigInt: true })
  } catch (error) {
    throw new Refused(`${OKR_FILE} 不是合法的 UTF-8 TOML:${(error as Error).message.split('\n')[0]}`)
  }
  const objectives = doc.objective ?? []
  if (!Array.isArray(objectives) || !objectives.every((o) => plain(o) && Array.isArray(o.kr ?? []) && ((o.kr ?? []) as unknown[]).every(plain))) {
    throw new Refused(`${OKR_FILE} 要写成 [[objective]] 下挂 [[objective.kr]]`)
  }
  for (const o of objectives as Record<string, unknown>[]) {
    for (const kr of (o.kr ?? []) as Record<string, unknown>[]) {
      if (typeof kr.name !== 'string' || !kr.name) throw new Refused(`${OKR_FILE}:${o.name} 下有一条 KR 没写 name`)
      if (!['measure', 'unit', 'wait'].every((k) => kr[k] === undefined || (typeof kr[k] === 'string' && !kr[k].includes('\0')))) {
        throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 measure、unit、wait 要写成字符串`)
      }
      const age = kr.max_age_days
      if (age !== undefined) {
        if (typeof age !== 'bigint' || age < 0n || age > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 max_age_days 要写成非负整数`)
        kr.max_age_days = Number(age)
      }
      if (typeof kr.target !== 'string' || !TARGET.test(kr.target.trim())) throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 target 要写成「>= 95」这样`)
    }
  }
  return objectives as Objective[]
}

/** [value, as-of] from the measure's last stdout line, "<number> <as-of>", or why it couldn't be read. */
export async function measure(root: string, cmd: string, timeout = MEASURE_TIMEOUT): Promise<[string, string] | string> {
  const text = (b: Buffer) => new TextDecoder().decode(b)
  let stdout: string
  try {
    stdout = text((await exec('/bin/sh', ['-c', cmd], { cwd: root, timeout, encoding: 'buffer', maxBuffer: 64 << 20 })).stdout)
  } catch (error) {
    const e = error as { killed?: boolean; code?: unknown; signal?: string; stderr?: Buffer }
    if (e.killed) return `超时（${timeout / 1000}s）`
    if (typeof e.code !== 'number' && !e.signal) throw error
    const err = text(e.stderr ?? Buffer.alloc(0)).trim().split(LINES)
    // The first error header (ValueError: …, Error [ERR_X]: …) beats a runtime footer like "Node.js v26".
    return `退出码 ${e.code ?? e.signal}：` + (err.find((l) => ERR_HEAD.test(l)) ?? err.at(-1)!).trim().slice(0, 120)
  }
  if (stdout.includes(REPLACED)) return '输出不是 UTF-8'
  const last = stdout.trim().split(LINES).at(-1)!.trim()
  const m = READING.exec(last)
  if (!m) return `最后一行不是「数值 截至」：'${last.slice(0, 60)}'`
  try {
    dec(m[1]!)
  } catch (error) {
    return (error as Error).message
  }
  return [m[1]!, m[2]!]
}

const ymd = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())

/** Why a reading is too old to count (its measurement window, by the local date), or '' when it's fresh. */
function stale(asOf: string, maxDays: number) {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(asOf)
  const day = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (!m || !day || day.getFullYear() !== Number(m[1]) || day.getMonth() !== Number(m[2]) - 1 || day.getDate() !== Number(m[3])) {
    return `测量失败：设了 max_age_days，截至要以 YYYY-MM-DD 开头：'${asOf.slice(0, 30)}'`
  }
  const old = (ymd(new Date()) - ymd(day)) / 86_400_000
  return old > maxDays ? `测量过期：截至 ${asOf.slice(0, 10)}，已 ${old} 天，超过 ${maxDays} 天` : ''
}

const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd }).then((r) => r.stdout.trim(), () => '')

/** A reading worth keeping: one whose as-of starts with a date. */
export type Reading = { objective: string; kr: string; value: string; as_of: string; source: string }

/** Each Objective with its KRs measured now; only a measured value meeting its target counts as met. */
export async function run(root: string, timeout = MEASURE_TIMEOUT) {
  const objectives = await defs(root)
  const head = (await git(root, 'log', '-1', '--format=%h %cs', '--', OKR_FILE)) || '未提交'
  const dirty = (await git(root, 'status', '--porcelain', '--', OKR_FILE)) ? '（有未提交改动）' : ''
  const out = [`OKR · 定义 ${OKR_FILE} @ ${head}${dirty}`]
  const readings: Reading[] = []
  const full = new Map<string, boolean>()
  for (const o of objectives) {
    const rows = []
    let met = 0
    for (const kr of o.kr ?? []) {
      const [op, goal] = target(kr)
      const unit = kr.unit ?? ''
      const want = `${op} ${goal}${unit}`
      const got = kr.measure ? await measure(root, kr.measure, timeout) : null
      const d = Array.isArray(got) ? AS_OF.exec(got[1]) : null
      // ponytail: a dateless as-of isn't kept: keyed on (as-of, source), it would pin its first value forever.
      if (Array.isArray(got) && d) readings.push({ objective: o.name, kr: kr.name, value: got[0], as_of: d[1]!, source: d[2]! })
      // ponytail: toFixed rounds half up where the old Decimal format rounded half even; display only.
      const shown = (v: string) => `${Number(v).toFixed(1)}${unit}`
      let why
      if (got === null) rows.push(`  · ${kr.name}  未测 / ${want}`)
      else if (typeof got === 'string') rows.push(`  ! ${kr.name}  测量失败：${got}`)
      else if (kr.max_age_days !== undefined && (why = stale(got[1], kr.max_age_days))) rows.push(`  ⌛ ${kr.name}  ${shown(got[0])} / ${want}  ${why}`)
      else {
        const ok = meets(op, dec(got[0]), dec(goal))
        met += Number(ok)
        rows.push(`  ${ok ? '✓' : '✗'} ${kr.name}  ${shown(got[0])} / ${want}  截至 ${got[1]}`)
      }
    }
    out.push(`O ${o.name} · ${met}/${rows.length} 达标`, ...rows)
    full.set(o.name, rows.length > 0 && met === rows.length)
  }
  return { text: out.join('\n'), readings, full, commit: head === '未提交' ? undefined : head.split(' ')[0] }
}

/**
 * (the declarations since the KR's last round, the tickets that round found off their word). A round is
 * one measured_at; its reading the one with the latest as-of. Only a declaration's first round judges it,
 * against the round before the declaration: ↑ must come closer to the target, = not move away; ↓ said
 * it would move away, so no round can catch it overclaiming.
 */
function impacts(op: string, goal: Dec, readings: Row[], declared: Declared[]) {
  const rounds = new Map<string, Row>()
  for (const r of readings) rounds.set(r.measured_at, r) // readings come by as-of: the last one per round wins
  const times = [...rounds.keys()].sort()
  const last = times.at(-1) ?? ''
  const pending = declared
    .filter((i) => i.declared_at >= last)
    .map((i) => ({ ticket: i.ticket, dir: i.dir, before: i.before, after: i.after, basis: i.basis, at: i.declared_at }))
  if (times.length < 2) return { pending, mismatch: [] }
  const prev = times.at(-2)!
  const moved = closer(op, goal, dec(rounds.get(prev)!.value), dec(rounds.get(last)!.value))
  const off = new Map<string, string>()
  for (const i of declared) {
    if (prev <= i.declared_at && i.declared_at < last && (i.dir === '↑' ? moved !== 'closer' : i.dir === '=' && moved === 'away')) off.set(i.ticket, i.dir)
  }
  return { pending, mismatch: [...off].map(([ticket, dir]) => ({ ticket, dir })) }
}

type Attention = { kind: 'five' | 'stuck' | 'wait' | 'accept'; objective: string; kr: string | null; text: string }
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * json okr's document: the kept readings judged against the okr.toml as it is now; it never runs a
 * measure. accepts maps an Objective to its latest accept; declared is keyed by objective and KR.
 */
export function judge(objectives: Objective[], rows: Row[], accepts: Map<string, string>, declared: Map<string, Declared[]>, repo: string, defCommit: string | null) {
  rows = [...rows].sort((a, b) => order(a.as_of, b.as_of) || order(a.measured_at, b.measured_at))
  const byKr = new Map<string, Row[]>()
  for (const r of rows) byKr.set(r.kr, [...(byKr.get(r.kr) ?? []), r])
  const out = {
    repo,
    def_commit: defCommit,
    last_measured_at: rows.reduce<string | null>((m, r) => (m === null || r.measured_at > m ? r.measured_at : m), null),
    met: 0,
    total: 0,
    objectives: [] as { name: string; met: number; total: number; accept_pending: boolean; impacts: Record<string, number>; krs: { name: string; mismatch: { ticket: string; dir: string }[] }[] }[],
    attention: [] as Attention[],
  }
  for (const o of objectives) {
    const name = o.name
    const krs = []
    const counts = { '↑': 0, '↓': 0, '=': 0 }
    let lateMiss = false
    for (const kr of o.kr ?? []) {
      const [op, goalText] = target(kr)
      const goal = dec(goalText)
      const rs = byKr.get(kr.name) ?? []
      const ok = (r: Row) => meets(op, dec(r.value), goal)
      let missed = 0
      for (const r of [...rs].reverse()) {
        if (ok(r)) break
        missed++
      }
      const last = rs.at(-1)
      // Only the latest reading goes stale; history is judged by value.
      const status = !last ? 'untested' : kr.max_age_days !== undefined && stale(last.as_of, kr.max_age_days) ? 'stale' : missed ? 'missed' : 'met'
      const trends = rs.slice(1).map((r, i) => closer(op, goal, dec(rs[i]!.value), dec(r.value)))
      const accepted = accepts.get(name)
      lateMiss ||= accepted !== undefined && rs.some((r) => r.measured_at > accepted && !ok(r))
      const { pending, mismatch } = impacts(op, goal, rs, declared.get(`${name}\0${kr.name}`) ?? [])
      for (const i of pending) counts[i.dir as keyof typeof counts]++
      krs.push({
        name: kr.name,
        target: `${op} ${goalText}`,
        unit: kr.unit ?? '',
        status,
        value: last ? Number(last.value) : null,
        as_of: last?.as_of ?? null,
        source: last?.source ?? null,
        history: rs.slice(-3).map((r) => ({ value: Number(r.value), as_of: r.as_of })),
        trend: trends.at(-1) ?? null,
        missed_rounds: missed,
        wait: kr.wait ?? null,
        impacts: pending,
        mismatch,
      })
      const seen = rs.slice(-3).map((r) => r.value).join('、')
      // A stale KR still counts: five missed rounds then silence is what to flag.
      if (missed >= 5) out.attention.push({ kind: 'five', objective: name, kr: kr.name, text: `连续 ${missed} 轮未达标（${op} ${goalText}），最近三次 ${seen}` })
      else if (status === 'missed' && trends.length >= 2 && !trends.slice(-2).includes('closer')) {
        out.attention.push({ kind: 'stuck', objective: name, kr: kr.name, text: `两轮没往目标走（${op} ${goalText}），最近三次 ${seen}` })
      }
      if (kr.wait && !kr.measure) out.attention.push({ kind: 'wait', objective: name, kr: kr.name, text: kr.wait })
    }
    const met = krs.filter((k) => k.status === 'met').length
    const pending = krs.length > 0 && met === krs.length && (!accepts.has(name) || lateMiss)
    if (pending) out.attention.push({ kind: 'accept', objective: name, kr: null, text: `${name} 全 ✓，待你验收（nawaban okr --accept）` })
    out.objectives.push({ name, met, total: krs.length, accept_pending: pending, impacts: counts, krs })
    out.met += met
    out.total += krs.length
  }
  return out
}

/** okr's lines for the declarations: each Objective's ↑ ↓ = since the last round, each KR off its word. */
export function impactText(data: ReturnType<typeof judge>) {
  const out = []
  for (const o of data.objectives) {
    const n = o.impacts
    if (Object.values(n).some(Boolean)) out.push(`O ${o.name} · 声明 ↑${n['↑']} ↓${n['↓']} =${n['=']}`)
    for (const k of o.krs) if (k.mismatch.length) out.push(`  预期不符 ${k.name}：` + k.mismatch.map((m) => `${m.ticket} 声明 ${m.dir}`).join('、'))
  }
  return out.join('\n')
}

export const okrChannel = (project: string) => `okr/${project}`
const key = (...parts: string[]) => 'okr-' + createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)
const blocksOf = (m: MessageView, schema: string) =>
  m.deleted ? [] : m.blocks.filter((b) => b.schema === schema && b.version === 1 && b.data).map((b) => b.data as Record<string, unknown>)

/** Every whole thread in a channel that has a message matching text, root first. */
async function threads(team: Team, channel: string, text?: string) {
  const out: MessageView[][] = []
  for (let page = await team.threads({ channel, text, limit: 500 }); ; page = await team.threads({ channel, text, limit: 500, before: page.older! })) {
    for (const t of page.threads) {
      // ponytail: thread() answers the whole thread; a KR with thousands of rounds would want its pages.
      const { message, replies } = await team.thread(t.message.id)
      out.push([message, ...replies])
    }
    if (!page.older) return out
  }
}

/** What the board holds for a project: its kept readings, each Objective's latest accept, and the declarations. */
export async function load(team: Team, project: string) {
  const rows: Row[] = []
  const accepts = new Map<string, string>()
  for (const thread of await threads(team, okrChannel(project))) {
    for (const m of thread) {
      for (const d of blocksOf(m, 'nawaban-kr-reading')) rows.push({ kr: d.kr, value: d.value, as_of: d.as_of, source: d.source, measured_at: m.createdAt } as Row)
      for (const d of blocksOf(m, 'nawaban-okr-accept')) {
        const o = d.objective as string
        if (m.createdAt > (accepts.get(o) ?? '')) accepts.set(o, m.createdAt)
      }
    }
  }
  const declared = new Map<string, Declared[]>()
  for (const [root, ...replies] of await threads(team, project, 'nawaban-impact')) {
    for (const m of [root!, ...replies]) {
      for (const d of blocksOf(m, 'nawaban-impact')) {
        for (const kr of d.krs as { name: string; dir: string; before?: string; after?: string; basis?: string }[]) {
          const k = `${d.objective}\0${kr.name}`
          const ticket = root!.labels.key ?? `#${root!.id}`
          declared.set(k, [...(declared.get(k) ?? []), { ticket, dir: kr.dir, before: kr.before ?? null, after: kr.after ?? null, basis: kr.basis ?? null, declared_at: m.createdAt }])
        }
      }
    }
  }
  for (const list of declared.values()) list.sort((a, b) => order(a.declared_at, b.declared_at))
  return { rows, accepts, declared }
}

/** Keeps each new reading once, keyed as the old table was on (KR, as-of, source); answers how many were new. */
export async function record(team: Team, project: string, readings: Reading[], commit?: string) {
  let n = 0
  for (const r of readings) {
    const id = key(project, r.kr, r.as_of, r.source)
    const kept = await team.posted(id).then(
      () => true,
      (error) => {
        if (error instanceof BoardError && error.code === 'post_not_found') return false
        throw error
      },
    )
    if (kept) continue
    const root = await team.post(okrChannel(project), { id: key(project, r.kr), text: r.kr })
    await team.reply(root.id, { id, text: block('nawaban-kr-reading@1', { ...r, ...(commit ? { commit } : {}) }) })
    n++
  }
  return n
}

/** The main checkout of the repository cwd is in (a worktree maps to it), or null outside one. */
export async function checkout(cwd: string) {
  const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return common ? realpath(join(common, '..')) : null
}

/** nawaban okr [--accept <O>]: measures every KR in this repository, keeps the readings, prints where each stands. */
export async function okr(argv: string[], team: Team, dir: string, { cwd = process.cwd(), timeout = MEASURE_TIMEOUT } = {}): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { accept: { type: 'string' } } })
    if (positionals.length) throw new Refused('usage: nawaban okr [--accept <O>]', 2)
    const top = await git(cwd, 'rev-parse', '--show-toplevel')
    if (!top) throw new Refused('okr 要在 git 仓库里跑')
    const { text, readings, full, commit } = await run(top, timeout)
    process.stdout.write(text + '\n')
    const repo = (await checkout(top))!
    const project = await projectOf(dir, repo)
    if (!project) {
      if (values.accept === undefined) {
        process.stderr.write(`(仓库 ${repo} 不在 ${join(dir, 'repos.json')},读数没记)\n`)
        return 0
      }
      throw new Refused(`仓库 ${repo} 不在 ${join(dir, 'repos.json')},记不了 accept`)
    }
    // The readings are kept even when the accept below is refused.
    const n = await record(team, project, readings, commit)
    if (values.accept !== undefined) {
      if (!full.get(values.accept)) {
        throw new Refused(`${full.has(values.accept) ? `${values.accept} 还没全 ✓,不收 accept` : `没有这个 O:${values.accept}`}(读数新记 ${n} 条)`)
      }
      // After this run's readings, so none of them counts as a miss since.
      await team.post(okrChannel(project), block('nawaban-okr-accept@1', { objective: values.accept }))
    }
    process.stdout.write(`读数新记 ${n} 条${values.accept !== undefined ? ` · ✓ accept ${values.accept}` : ''}\n`)
    const { rows, accepts, declared } = await load(team, project)
    const lines = impactText(judge(await defs(repo), rows, accepts, declared, repo, null))
    if (lines) process.stdout.write(lines + '\n')
    return 0
  } catch (error) {
    const misuse = (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
    if (!(error instanceof Refused || error instanceof BoardError || misuse)) throw error
    process.stderr.write(`error: ${(error as Error).message}\n`)
    return error instanceof Refused ? error.code : misuse ? 2 : 1
  }
}

/** nawaban json okr [--repo <path>]: the board's readings for the repository, judged; never measures. Errors are JSON too. */
export async function jsonOkr(argv: string[], team: Team, dir: string, cwd = process.cwd()): Promise<number> {
  let out
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { repo: { type: 'string' } } })
    if (positionals.length) throw new Refused('usage: nawaban json okr [--repo <path>]', 2)
    const repo = await checkout(values.repo ?? cwd)
    if (!repo) throw new Refused('json okr 要在 git 仓库里跑,或给 --repo')
    const objectives = await defs(repo)
    const project = await projectOf(dir, repo)
    if (!project) throw new Refused(`仓库 ${repo} 不在 ${join(dir, 'repos.json')}`)
    const { rows, accepts, declared } = await load(team, project)
    out = judge(objectives, rows, accepts, declared, repo, (await git(repo, 'log', '-1', '--format=%h', '--', OKR_FILE)) || null)
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as Error).message }) + '\n')
    return error instanceof Refused ? error.code : 1
  }
  process.stdout.write(JSON.stringify(out) + '\n')
  return 0
}
