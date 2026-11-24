import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, sep } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { block, BoardError, type board, type MessageView } from '@vercel/board'
import { parse } from 'smol-toml'
import { OKR_FILE, projectOf } from './impact.ts'
import { Refused } from './tasks.ts'

type Team = ReturnType<typeof board>
export type Kr = { name: string; target: string; unit?: string; measure?: string; wait?: string; max_age_days?: number }
export type Objective = { name: string; kr?: Kr[] }
export type KeptReading = { kr: string; value: string; as_of: string; source: string; measured_at: Round; def_hash: string }
export type Declared = { ticket: string; dir: string; before: string | null; after: string | null; basis: string | null; declared_at: string }
export type Reading = { objective: string; kr: string; value: string; as_of: string; source: string; def_hash?: string }
type Round = string
type Movement = 'closer' | 'away' | 'flat'

export const MEASURE_READS_RESULTS_NEVER_RUNS_AN_EVAL_TIMEOUT = 60_000
const MEASURE_STDOUT_MAX = 64 << 20
const FAILURE_LINE_MAX = 120
const UNREADABLE_LAST_LINE_SHOWN = 60
const UNDATED_AS_OF_SHOWN = 30
const EXPONENT_CAP_KEEPING_POW10_CHEAP = 1000
const MISSED_ROUNDS_TO_FLAG = 5
const ROUNDS_WITHOUT_PROGRESS_TO_FLAG = 2
const READINGS_SHOWN = 3
const DAY_MS = 86_400_000
const THREADS_PAGE = 500
const ID_HASH_LENGTH = 32
const BOARD_ID_WIDTH_SO_LOG_INDEX_SORTS_AS_TEXT = 20
const NOT_COMMITTED = '未提交'
export const FAILED = ''
const DEF_HASH_LENGTH = 16
const KR_FIELDS_IN_DEF_HASH = ['max_age_days', 'measure', 'name', 'target', 'unit', 'wait'] as const
const MEASURE_CODE_SUFFIXES = ['.ts', '.mts', '.js', '.mjs', '.cjs', '.py', '.sh']

const TARGET = /^(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/
const READING = /^(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+(\S.*)$/
const DATED_AS_OF = /^(\d{4}-\d\d-\d\d\S*)\s*(.*)$/s
const ERROR_HEADER_NOT_RUNTIME_FOOTER = /^\s*[\w.]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:/
const LINES = /\r\n|[\n\r\v\f\x1c-\x1e\x85\u{2028}\u{2029}]/u
const REPLACED = '\u{fffd}'
const exec = promisify(execFile)

type ExactDecimalAsTheOldClisDecimal = { n: bigint; e: number }
export function dec(s: string): ExactDecimalAsTheOldClisDecimal {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(s.trim())
  const e = Number(m?.[4] ?? 0) - (m?.[3] ?? '').length
  if (!m || Math.abs(e) > EXPONENT_CAP_KEEPING_POW10_CHEAP) throw new Refused(`不是数值:${s}`)
  return { n: BigInt(m[1]! + m[2]! + (m[3] ?? '')), e }
}
const align = (a: ExactDecimalAsTheOldClisDecimal, b: ExactDecimalAsTheOldClisDecimal): [bigint, bigint, number] => {
  const e = Math.min(a.e, b.e)
  return [a.n * 10n ** BigInt(a.e - e), b.n * 10n ** BigInt(b.e - e), e]
}
const cmp = (a: ExactDecimalAsTheOldClisDecimal, b: ExactDecimalAsTheOldClisDecimal) => {
  const [x, y] = align(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}
const meets = (op: string, v: ExactDecimalAsTheOldClisDecimal, goal: ExactDecimalAsTheOldClisDecimal) => {
  const c = cmp(v, goal)
  return op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0
}

function distanceToTarget(op: string, goal: ExactDecimalAsTheOldClisDecimal, v: ExactDecimalAsTheOldClisDecimal): ExactDecimalAsTheOldClisDecimal {
  const wantsMore = op === '>=' || op === '>'
  const wantsLess = op === '<=' || op === '<'
  if (wantsMore) return { n: -v.n, e: v.e }
  if (wantsLess) return v
  const [x, y, e] = align(v, goal)
  return { n: x > y ? x - y : y - x, e }
}

function movementTowardTarget(op: string, goal: ExactDecimalAsTheOldClisDecimal, prev: ExactDecimalAsTheOldClisDecimal, cur: ExactDecimalAsTheOldClisDecimal): Movement {
  const c = cmp(distanceToTarget(op, goal, cur), distanceToTarget(op, goal, prev))
  return c < 0 ? 'closer' : c > 0 ? 'away' : 'flat'
}
const target = (kr: Kr) => TARGET.exec(kr.target.trim())!.slice(1) as [string, string]

const plain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x) && !(x instanceof Date)

function refuseWholeFileNeverSkipAKr(objectives: unknown): asserts objectives is Objective[] {
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
}

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
  refuseWholeFileNeverSkipAKr(objectives)
  return objectives
}

const utf8 = (b: Buffer) => new TextDecoder().decode(b)

function failureLine(code: unknown, stderr: Buffer | undefined) {
  const err = utf8(stderr ?? Buffer.alloc(0)).trim().split(LINES)
  return `退出码 ${code}：` + (err.find((l) => ERROR_HEADER_NOT_RUNTIME_FOOTER.test(l)) ?? err.at(-1)!).trim().slice(0, FAILURE_LINE_MAX)
}

export async function measure(root: string, cmd: string, timeout = MEASURE_READS_RESULTS_NEVER_RUNS_AN_EVAL_TIMEOUT): Promise<[string, string] | string> {
  let stdout: string
  try {
    stdout = utf8((await exec('/bin/sh', ['-c', cmd], { cwd: root, timeout, encoding: 'buffer', maxBuffer: MEASURE_STDOUT_MAX })).stdout)
  } catch (error) {
    const e = error as { killed?: boolean; code?: unknown; signal?: string; stderr?: Buffer }
    if (e.killed) return `超时（${timeout / 1000}s）`
    if (typeof e.code !== 'number' && !e.signal) throw error
    return failureLine(e.code ?? e.signal, e.stderr)
  }
  if (stdout.includes(REPLACED)) return '输出不是 UTF-8'
  const last = stdout.trim().split(LINES).at(-1)!.trim()
  const m = READING.exec(last)
  if (!m) return `最后一行不是「数值 截至」：'${last.slice(0, UNREADABLE_LAST_LINE_SHOWN)}'`
  try {
    dec(m[1]!)
  } catch (error) {
    return (error as Error).message
  }
  return [m[1]!, m[2]!]
}

const ymd = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())

function whyTooOldByLocalDate(asOf: string, maxDays: number) {
  const m = /^(\d{4})-(\d\d)-(\d\d)/.exec(asOf)
  const day = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (!m || !day || day.getFullYear() !== Number(m[1]) || day.getMonth() !== Number(m[2]) - 1 || day.getDate() !== Number(m[3])) {
    return `测量失败：设了 max_age_days，截至要以 YYYY-MM-DD 开头：'${asOf.slice(0, UNDATED_AS_OF_SHOWN)}'`
  }
  const old = (ymd(new Date()) - ymd(day)) / DAY_MS
  return old > maxDays ? `测量过期：截至 ${asOf.slice(0, 10)}，已 ${old} 天，超过 ${maxDays} 天` : ''
}

const git = (cwd: string, ...args: string[]) => exec('git', args, { cwd }).then((r) => r.stdout.trim(), () => '')

const sha256 = (data: string | Buffer) => createHash('sha256').update(data)

async function repoFilesNamedIn(root: string, cmd: string) {
  const named: string[] = []
  for (const word of cmd.split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]+|['"]+$/g, ''))) {
    const inside = !isAbsolute(word) && !word.split(sep).includes('..')
    if (!inside || !MEASURE_CODE_SUFFIXES.includes(extname(word)) || named.includes(word)) continue
    if (await stat(join(root, word)).then((s) => s.isFile(), () => false)) named.push(word)
  }
  return named
}

export async function defHash(root: string, kr: Kr) {
  const entry = Object.fromEntries(KR_FIELDS_IN_DEF_HASH.filter((k) => kr[k] !== undefined).map((k) => [k, kr[k]]))
  const h = sha256(JSON.stringify(entry))
  for (const name of await repoFilesNamedIn(root, kr.measure ?? '')) {
    h.update(`\0${name}\0${sha256(await readFile(join(root, name))).digest('hex')}`)
  }
  return h.digest('hex').slice(0, DEF_HASH_LENGTH)
}

async function keptReadingOrFailure(root: string, o: Objective, kr: Kr, got: [string, string] | string | null): Promise<Reading | null> {
  if (typeof got === 'string') return { objective: o.name, kr: kr.name, value: FAILED, as_of: '', source: got, def_hash: await defHash(root, kr) }
  const d = Array.isArray(got) ? DATED_AS_OF.exec(got[1]) : null
  return Array.isArray(got) && d ? { objective: o.name, kr: kr.name, value: got[0], as_of: d[1]!, source: d[2]!, def_hash: await defHash(root, kr) } : null
}

const shownRoundedHalfUpForDisplayOnly = (v: string, unit: string) => `${Number(v).toFixed(1)}${unit}`
const UNITS_COUNTED_IN_POINTS = new Set(['%', '百分点', '个百分点'])
const ISO_DAY = /^\d{4}-(\d\d-\d\d)/
const monthDayElseAsWritten = (asOf: string) => ISO_DAY.exec(asOf)?.[1] ?? asOf

function varianceText(op: string, value: string, goal: string, unit: string) {
  const v = Number(value), g = Number(goal)
  const variance = op === '==' ? -Math.abs(v - g) : op === '<=' || op === '<' ? g - v : v - g
  const shownUnit = UNITS_COUNTED_IN_POINTS.has(unit) ? '点' : unit
  return `${variance < 0 ? '-' : '+'}${Math.abs(variance).toFixed(1)}${shownUnit ? ' ' + shownUnit : ''}`
}

function measuredRow(kr: Kr, got: [string, string] | string | null): { row: string; met: boolean } {
  const [op, goal] = target(kr)
  const unit = kr.unit ?? ''
  const want = `${op} ${goal}${unit}`
  if (got === null) return { row: `  ${kr.name}  未测 / 目标 ${want}`, met: false }
  if (typeof got === 'string') return { row: `  ${kr.name}  量不了 / 目标 ${want} · 测量失败：${got}`, met: false }
  const line = (rag: string) =>
    `  ${kr.name}  ${shownRoundedHalfUpForDisplayOnly(got[0], unit)} / 目标 ${want} · 偏差 ${varianceText(op, got[0], goal, unit)} · ${rag} · 截至 ${monthDayElseAsWritten(got[1])}`
  const why = kr.max_age_days !== undefined ? whyTooOldByLocalDate(got[1], kr.max_age_days) : ''
  if (why) return { row: `${line('黄')}  ${why}`, met: false }
  const met = meets(op, dec(got[0]), dec(goal))
  return { row: line(met ? '绿' : '红'), met }
}

export async function run(root: string, timeout = MEASURE_READS_RESULTS_NEVER_RUNS_AN_EVAL_TIMEOUT) {
  const objectives = await defs(root)
  const head = (await git(root, 'log', '-1', '--format=%h %cs', '--', OKR_FILE)) || NOT_COMMITTED
  const dirty = (await git(root, 'status', '--porcelain', '--', OKR_FILE)) ? '（有未提交改动）' : ''
  const out = [`OKR · 定义 ${OKR_FILE} @ ${head}${dirty}`]
  const readings: Reading[] = []
  const full = new Map<string, boolean>()
  for (const o of objectives) {
    const rows = []
    let met = 0
    for (const kr of o.kr ?? []) {
      const got = kr.measure ? await measure(root, kr.measure, timeout) : null
      const kept = await keptReadingOrFailure(root, o, kr, got)
      if (kept) readings.push(kept)
      const r = measuredRow(kr, got)
      met += Number(r.met)
      rows.push(r.row)
    }
    out.push(`O ${o.name} · ${met}/${rows.length} 达标`, ...rows)
    full.set(o.name, rows.length > 0 && met === rows.length)
  }
  return { text: out.join('\n'), readings, full, commit: head === NOT_COMMITTED ? undefined : head.split(' ')[0] }
}

function latestAsOfPerRound(readingsByAsOf: KeptReading[]) {
  const rounds = new Map<Round, KeptReading>()
  for (const r of readingsByAsOf) rounds.set(r.measured_at, r)
  return rounds
}

const judgedOnlyByItsFirstRound = (i: Declared, prev: Round, last: Round) => prev <= i.declared_at && i.declared_at < last
const offItsWord = (dir: string, moved: Movement) => (dir === '↑' ? moved !== 'closer' : dir === '=' && moved === 'away')

function declarationsSinceLastRoundAndOffTheirWord(op: string, goal: ExactDecimalAsTheOldClisDecimal, readings: KeptReading[], declared: Declared[]) {
  const rounds = latestAsOfPerRound(readings)
  const times = [...rounds.keys()].sort()
  const last = times.at(-1) ?? ''
  const pending = declared
    .filter((i) => i.declared_at >= last)
    .map((i) => ({ ticket: i.ticket, dir: i.dir, before: i.before, after: i.after, basis: i.basis, at: withoutTieBreak(i.declared_at) }))
  if (times.length < 2) return { pending, mismatch: [] }
  const prev = times.at(-2)!
  const moved = movementTowardTarget(op, goal, dec(rounds.get(prev)!.value), dec(rounds.get(last)!.value))
  const off = new Map<string, string>()
  for (const i of declared) {
    if (judgedOnlyByItsFirstRound(i, prev, last) && offItsWord(i.dir, moved)) off.set(i.ticket, i.dir)
  }
  return { pending, mismatch: [...off].map(([ticket, dir]) => ({ ticket, dir })) }
}

type Attention = { kind: 'five' | 'stuck' | 'wait' | 'accept'; objective: string; kr: string | null; text: string }
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const withoutTieBreak = (at: string) => at.split('~')[0]!

const sameReading = (a: KeptReading, b: KeptReading) => a.value === b.value && a.as_of === b.as_of && a.source === b.source && a.def_hash === b.def_hash

function roundsAndCurrentSeries(kept: KeptReading[]) {
  const readings = kept.filter((r) => r.value !== FAILED)
  const rounds = readings.filter((r, i) => i === 0 || !sameReading(readings[i - 1]!, r))
  const starts = rounds.flatMap((r, i) => (i === 0 || rounds[i - 1]!.def_hash !== r.def_hash ? [i] : []))
  return { rounds, series: starts.length ? rounds.slice(starts.at(-1)) : [], version: starts.length }
}

function missedRoundsSinceLastMet(rs: KeptReading[], ok: (r: KeptReading) => boolean) {
  let missed = 0
  for (const r of [...rs].reverse()) {
    if (ok(r)) break
    missed++
  }
  return missed
}

function statusOnlyTheLatestReadingGoesStale(kr: Kr, last: KeptReading | undefined, missed: number) {
  if (!last) return 'untested'
  if (kr.max_age_days !== undefined && whyTooOldByLocalDate(last.as_of, kr.max_age_days)) return 'stale'
  return missed ? 'missed' : 'met'
}

function attentionEvenWhenStale(name: string, kr: Kr, op: string, goalText: string, status: string, missed: number, trends: Movement[], rs: KeptReading[]): Attention[] {
  const out: Attention[] = []
  const seen = rs.slice(-READINGS_SHOWN).map((r) => r.value).join('、')
  const noRecentProgress = trends.length >= ROUNDS_WITHOUT_PROGRESS_TO_FLAG && !trends.slice(-ROUNDS_WITHOUT_PROGRESS_TO_FLAG).includes('closer')
  if (missed >= MISSED_ROUNDS_TO_FLAG) out.push({ kind: 'five', objective: name, kr: kr.name, text: `连续 ${missed} 轮未达标（${op} ${goalText}），最近三次 ${seen}` })
  else if (status === 'missed' && noRecentProgress) {
    out.push({ kind: 'stuck', objective: name, kr: kr.name, text: `两轮没往目标走（${op} ${goalText}），最近三次 ${seen}` })
  }
  if (kr.wait && !kr.measure) out.push({ kind: 'wait', objective: name, kr: kr.name, text: kr.wait })
  return out
}

export function judge(objectives: Objective[], rows: KeptReading[], accepts: Map<string, string>, declared: Map<string, Declared[]>, repo: string, defCommit: string | null) {
  rows = [...rows].sort((a, b) => order(a.measured_at, b.measured_at) || order(a.as_of, b.as_of))
  const byKr = new Map<string, KeptReading[]>()
  for (const r of rows) byKr.set(r.kr, [...(byKr.get(r.kr) ?? []), r])
  const out = {
    repo,
    def_commit: defCommit,
    last_measured_at: rows.reduce<string | null>((m, r) => (m === null || r.measured_at > m ? r.measured_at : m), null)?.split('~')[0] ?? null,
    met: 0,
    total: 0,
    objectives: [] as { name: string; met: number; total: number; accept_pending: boolean; impacts: Record<string, number>; krs: { name: string; mismatch: { ticket: string; dir: string }[] }[] }[],
    attention: [] as Attention[],
  }
  for (const o of objectives) {
    const name = o.name
    const krs = []
    const counts = { '↑': 0, '↓': 0, '=': 0 }
    let missedSinceAccept = false
    for (const kr of o.kr ?? []) {
      const [op, goalText] = target(kr)
      const goal = dec(goalText)
      const kept = byKr.get(kr.name) ?? []
      const { rounds, ...current } = roundsAndCurrentSeries(kept)
      const failure = kept.at(-1)?.value === FAILED ? kept.at(-1)!.source : null
      const failedUnderANewMeasure = failure !== null && current.series.length > 0 && kept.at(-1)!.def_hash !== current.series.at(-1)!.def_hash
      const rs = failedUnderANewMeasure ? [] : current.series
      const version = current.version + Number(failedUnderANewMeasure)
      const ok = (r: KeptReading) => meets(op, dec(r.value), goal)
      const missed = missedRoundsSinceLastMet(rs, ok)
      const last = rs.at(-1)
      const status = failure !== null ? 'unmeasurable' : statusOnlyTheLatestReadingGoesStale(kr, last, missed)
      const trends = rs.slice(1).map((r, i) => movementTowardTarget(op, goal, dec(rs[i]!.value), dec(r.value)))
      const accepted = accepts.get(name)
      missedSinceAccept ||= accepted !== undefined && rounds.some((r) => r.measured_at > accepted && !ok(r))
      const { pending, mismatch } = declarationsSinceLastRoundAndOffTheirWord(op, goal, rs, declared.get(`${name}\0${kr.name}`) ?? [])
      for (const i of pending) counts[i.dir as keyof typeof counts]++
      krs.push({
        name: kr.name,
        target: `${op} ${goalText}`,
        target_op: op,
        target_value: Number(goalText),
        unit: kr.unit ?? '',
        status,
        value: last ? Number(last.value) : null,
        as_of: last?.as_of ?? null,
        source: last?.source ?? null,
        history: rs.slice(-READINGS_SHOWN).map((r) => ({ value: Number(r.value), as_of: r.as_of })),
        trend: trends.at(-1) ?? null,
        missed_rounds: missed,
        wait: kr.wait ?? null,
        impacts: pending,
        mismatch,
        failure,
        series: rs.length ? { version, since: withoutTieBreak(rs[0]!.measured_at).slice(0, 10), def_hash: rs[0]!.def_hash } : null,
      })
      out.attention.push(...attentionEvenWhenStale(name, kr, op, goalText, status, missed, trends, rs))
    }
    const met = krs.filter((k) => k.status === 'met').length
    const pending = krs.length > 0 && met === krs.length && (!accepts.has(name) || missedSinceAccept)
    if (pending) out.attention.push({ kind: 'accept', objective: name, kr: null, text: `${name} 全 ✓，待你验收（nawaban okr --accept）` })
    out.objectives.push({ name, met, total: krs.length, accept_pending: pending, impacts: counts, krs })
    out.met += met
    out.total += krs.length
  }
  return out
}

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

const onTheOneClock = (m: MessageView): Round => `${m.createdAt}~${m.id.padStart(BOARD_ID_WIDTH_SO_LOG_INDEX_SORTS_AS_TEXT, '0')}`
export const key = (...parts: string[]) => 'okr-' + createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, ID_HASH_LENGTH)
const blocksOf = (m: MessageView, schema: string, version = 1) =>
  m.deleted ? [] : m.blocks.filter((b) => b.schema === schema && b.version === version && b.data).map((b) => b.data as Record<string, unknown>)

function keptOf(m: MessageView): KeptReading[] {
  const measured_at = onTheOneClock(m)
  return [
    ...blocksOf(m, 'nawaban-kr-reading').map((d) => ({ kr: d.kr, value: d.value, as_of: d.as_of, source: d.source, measured_at, def_hash: '' }) as KeptReading),
    ...blocksOf(m, 'nawaban-kr-reading', 2).map((d) => ({ kr: d.kr, value: d.value, as_of: d.as_of, source: d.source, measured_at, def_hash: d.def_hash }) as KeptReading),
    ...blocksOf(m, 'nawaban-kr-failure').map((d) => ({ kr: d.kr, value: FAILED, as_of: '', source: d.failure, measured_at, def_hash: d.def_hash }) as KeptReading),
  ]
}

async function wholeThreadsRootFirst(team: Team, channel: string, text?: string) {
  const out: MessageView[][] = []
  for (let page = await team.threads({ channel, text, limit: THREADS_PAGE }); ; page = await team.threads({ channel, text, limit: THREADS_PAGE, before: page.older! })) {
    for (const t of page.threads) {
      const { message, replies } = await team.thread(t.message.id)
      out.push([message, ...replies])
    }
    if (!page.older) return out
  }
}

export async function load(team: Team, project: string) {
  const rows: KeptReading[] = []
  const latestAccept = new Map<string, string>()
  for (const thread of await wholeThreadsRootFirst(team, okrChannel(project))) {
    for (const m of thread) {
      rows.push(...keptOf(m))
      for (const d of blocksOf(m, 'nawaban-okr-accept')) {
        const o = d.objective as string
        if (onTheOneClock(m) > (latestAccept.get(o) ?? '')) latestAccept.set(o, onTheOneClock(m))
      }
    }
  }
  const declared = new Map<string, Declared[]>()
  for (const [root, ...replies] of await wholeThreadsRootFirst(team, project, 'nawaban-impact')) {
    for (const m of [root!, ...replies]) {
      for (const d of blocksOf(m, 'nawaban-impact')) {
        for (const kr of d.krs as { name: string; dir: string; before?: string; after?: string; basis?: string }[]) {
          const k = `${d.objective}\0${kr.name}`
          const ticket = root!.labels.key ?? `#${root!.id}`
          declared.set(k, [...(declared.get(k) ?? []), { ticket, dir: kr.dir, before: kr.before ?? null, after: kr.after ?? null, basis: kr.basis ?? null, declared_at: onTheOneClock(m) }])
        }
      }
    }
  }
  for (const list of declared.values()) list.sort((a, b) => order(a.declared_at, b.declared_at))
  return { rows, accepts: latestAccept, declared }
}

async function latestKept(team: Team, clientId: string) {
  const root = await team.posted(clientId).catch((error) => {
    if (error instanceof BoardError && error.code === 'post_not_found') return null
    throw error
  })
  const found = root ? await team.thread(root.id).then((t) => [t.message, ...t.replies]) : []
  const kept = found.flatMap((m) => keptOf(m).map((r) => ({ ...r, id: m.id })))
  return kept.sort((a, b) => order(a.measured_at, b.measured_at)).at(-1) ?? null
}

export async function keepEachNewReadingOnce(team: Team, project: string, readings: Reading[], commit?: string) {
  let n = 0
  for (const r of readings) {
    const thread = key(project, r.kr)
    const def_hash = r.def_hash ?? ''
    const latest = await latestKept(team, thread)
    if (latest && sameReading(latest, { ...r, def_hash, measured_at: '' })) continue
    await keepAs(team, project, r, key(project, r.kr, latest?.id ?? '', r.value, r.as_of, r.source, def_hash), commit)
    n += Number(r.value !== FAILED)
  }
  return n
}

export async function keepAs(team: Team, project: string, r: Reading, id: string, commit?: string) {
  const data = { objective: r.objective, kr: r.kr, ...(commit ? { commit } : {}) }
  const def_hash = r.def_hash ?? ''
  const text =
    r.value === FAILED
      ? block('nawaban-kr-failure@1', { ...data, failure: r.source, def_hash })
      : r.def_hash === undefined
        ? block('nawaban-kr-reading@1', { ...data, value: r.value, as_of: r.as_of, source: r.source })
        : block('nawaban-kr-reading@2', { ...data, value: r.value, as_of: r.as_of, source: r.source, def_hash })
  const oneThreadPerKr = await team.post(okrChannel(project), { id: key(project, r.kr), text: r.kr })
  await team.reply(oneThreadPerKr.id, { id, text })
}

export async function mainCheckout(cwd: string) {
  const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  return common ? realpath(join(common, '..')) : null
}

async function acceptAfterThisRunsReadingsSoNoneCountsAsAMissSince(team: Team, project: string, objective: string, full: Map<string, boolean>, kept: number) {
  if (!full.get(objective)) {
    throw new Refused(`${full.has(objective) ? `${objective} 还没全 ✓,不收 accept` : `没有这个 O:${objective}`}(读数新记 ${kept} 条)`)
  }
  await team.post(okrChannel(project), block('nawaban-okr-accept@1', { objective }))
}

const exitCodeOfRefusalOrBoardError = (error: unknown) => {
  const misuse = (error as { code?: unknown }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
  if (!(error instanceof Refused || error instanceof BoardError || misuse)) throw error
  process.stderr.write(`error: ${(error as Error).message}\n`)
  return error instanceof Refused ? error.code : misuse ? 2 : 1
}

export async function okr(argv: string[], team: Team, dir: string, { cwd = process.cwd(), timeout = MEASURE_READS_RESULTS_NEVER_RUNS_AN_EVAL_TIMEOUT } = {}): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { accept: { type: 'string' } } })
    if (positionals.length) throw new Refused('usage: nawaban okr [--accept <O>]', 2)
    const top = await git(cwd, 'rev-parse', '--show-toplevel')
    if (!top) throw new Refused('okr 要在 git 仓库里跑')
    const { text, readings, full, commit } = await run(top, timeout)
    process.stdout.write(text + '\n')
    const repo = (await mainCheckout(top))!
    const project = await projectOf(dir, repo)
    if (!project) {
      if (values.accept === undefined) {
        process.stderr.write(`(仓库 ${repo} 不在 ${join(dir, 'repos.json')},读数没记)\n`)
        return 0
      }
      throw new Refused(`仓库 ${repo} 不在 ${join(dir, 'repos.json')},记不了 accept`)
    }
    const keptEvenIfTheAcceptIsRefused = await keepEachNewReadingOnce(team, project, readings, commit)
    if (values.accept !== undefined) await acceptAfterThisRunsReadingsSoNoneCountsAsAMissSince(team, project, values.accept, full, keptEvenIfTheAcceptIsRefused)
    process.stdout.write(`读数新记 ${keptEvenIfTheAcceptIsRefused} 条${values.accept !== undefined ? ` · ✓ accept ${values.accept}` : ''}\n`)
    const { rows, accepts, declared } = await load(team, project)
    const lines = impactText(judge(await defs(repo), rows, accepts, declared, repo, null))
    if (lines) process.stdout.write(lines + '\n')
    return 0
  } catch (error) {
    return exitCodeOfRefusalOrBoardError(error)
  }
}

export async function okrData(team: Team, dir: string, inRepo: string) {
  const repo = await mainCheckout(inRepo)
  if (!repo) throw new Refused('json okr 要在 git 仓库里跑,或给 --repo')
  const objectives = await defs(repo)
  const project = await projectOf(dir, repo)
  if (!project) throw new Refused(`仓库 ${repo} 不在 ${join(dir, 'repos.json')}`)
  const { rows, accepts, declared } = await load(team, project)
  return judge(objectives, rows, accepts, declared, repo, (await git(repo, 'log', '-1', '--format=%h', '--', OKR_FILE)) || null)
}

export async function jsonOkr(argv: string[], team: Team, dir: string, cwd = process.cwd()): Promise<number> {
  let out
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { repo: { type: 'string' } } })
    if (positionals.length) throw new Refused('usage: nawaban json okr [--repo <path>]', 2)
    out = await okrData(team, dir, values.repo ?? cwd)
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: (error as Error).message }) + '\n')
    return error instanceof Refused ? error.code : 1
  }
  process.stdout.write(JSON.stringify(out) + '\n')
  return 0
}
