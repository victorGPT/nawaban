import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, sep } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { block, BoardError, type board, type MessageView } from '@vercel/board'
import { parse } from 'smol-toml'
import { OKR_FILE, projectOf } from './impact.ts'
import { Refused } from './tasks.ts'

type Team = ReturnType<typeof board>
export type Kr = { name: string; target: string; kind?: string; baseline?: string; unit?: string; measure?: string; wait?: string; max_age_days?: number; inputs?: string[] }
export type Objective = { name: string; kr?: Kr[] }
export type KeptReading = { kr: string; value: string; as_of: string; source: string; measured_at: Round; def_hash: string }
export type Heading = 'toward' | 'away' | 'hold'
export type Change = 'product' | 'measure' | 'gold'
export type Declared = {
  ticket: string
  dir: string | null
  heading: Heading | null
  change: Change
  late: boolean
  before: string | null
  after: string | null
  basis: string | null
  def_hash: string | null
  declared_at: string
  result_at: string | null
}
export type OkrRound = { at: string; n: number; kept: number; moved: string[]; done: string[] }
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
const KR_KINDS = ['committed', 'aspirational']
export const ASPIRATIONAL_DONE_SCORE = 0.7
const SCORE_PLACES = 2
const STILL_ROUNDS_TO_STOP = 2
const SPRINT_ROUNDS_TO_STOP = 5
export const HARD_STOP_EXIT = 3
const THREADS_PAGE = 500
const ID_HASH_LENGTH = 32
const BOARD_ID_WIDTH_SO_LOG_INDEX_SORTS_AS_TEXT = 20
const NOT_COMMITTED = '未提交'
export const FAILED = ''
const DEF_HASH_LENGTH = 16
const KR_FIELDS_IN_DEF_HASH = ['inputs', 'max_age_days', 'measure', 'name', 'target', 'unit', 'wait'] as const
const GLOB_SYNTAX_THE_TWO_CLIS_READ_APART = /[{}[\]()!\\]/
const MEASURE_CODE_SUFFIXES = ['.ts', '.mts', '.js', '.mjs', '.cjs', '.py', '.sh']
const SHELL_SEPARATORS = /[\s'"`;|&<>()=]+/

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
      const inputs = kr.inputs ?? []
      if (!Array.isArray(inputs) || !inputs.every((i) => typeof i === 'string' && i && !i.includes('\0'))) {
        throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 inputs 要写成非空字符串的数组`)
      }
      if (inputs.some((i) => GLOB_SYNTAX_THE_TWO_CLIS_READ_APART.test(i) || i.split('/').some((s: string) => s === '.' || s === '..'))) {
        throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 inputs 只认 *、?、** 通配，不收 {}[]()!\\，也不收 . 和 .. 段`)
      }
      const age = kr.max_age_days
      if (age !== undefined) {
        if (typeof age !== 'bigint' || age < 0n || age > BigInt(Number.MAX_SAFE_INTEGER)) throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 max_age_days 要写成非负整数`)
        kr.max_age_days = Number(age)
      }
      if (kr.kind !== undefined && !KR_KINDS.includes(kr.kind as string)) throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 kind 只能写 committed 或 aspirational`)
      if (kr.baseline !== undefined && (typeof kr.baseline !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(kr.baseline.trim()))) {
        throw new Refused(`${OKR_FILE}:${o.name} / ${kr.name} 的 baseline 要写成数字字符串，如 "80"`)
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
  for (const word of cmd.split(SHELL_SEPARATORS).filter(Boolean)) {
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
  for (const pattern of kr.inputs ?? []) {
    const digests = await Promise.all((await inputFiles(root, pattern)).map(async (f) => sha256(await readFile(f)).digest('hex')))
    h.update(`\0${pattern}\0${digests.sort().join(',')}`)
  }
  return h.digest('hex').slice(0, DEF_HASH_LENGTH)
}

async function inputFiles(root: string, pattern: string) {
  const expanded = pattern === '~' || pattern.startsWith('~/') ? homedir() + pattern.slice(1) : pattern
  const found = await filesMatching(isAbsolute(expanded) ? '/' : root, expanded.split('/').filter(Boolean))
  return [...new Set(await Promise.all(found.map((f) => realpath(f))))]
}

const isFile = (p: string) => stat(p).then((s) => s.isFile(), () => false)
const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false)
const isLink = (p: string) => lstat(p).then((s) => s.isSymbolicLink(), () => false)
const entries = (p: string) => readdir(p).catch(() => [] as string[])
const REGEX_SPECIALS = /[.+^$|\\/]/g

async function filesMatching(at: string, segments: string[]): Promise<string[]> {
  const [segment, ...rest] = segments
  if (segment === undefined) return (await isFile(at)) ? [at] : []
  if (segment === '**') {
    const found = await filesMatching(at, rest)
    for (const name of await entries(at)) {
      const child = join(at, name)
      if (!name.startsWith('.') && (await isDir(child)) && !(await isLink(child))) found.push(...(await filesMatching(child, segments)))
    }
    return found
  }
  if (!/[*?]/.test(segment)) return filesMatching(join(at, segment), rest)
  const whole = new RegExp('^' + segment.replace(REGEX_SPECIALS, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$', 'u')
  const found: string[] = []
  for (const name of await entries(at)) {
    if ((segment.startsWith('.') || !name.startsWith('.')) && whole.test(name)) found.push(...(await filesMatching(join(at, name), rest)))
  }
  return found
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

const greenUnitOf = (kr: Kr) => (kr.kind === 'committed' ? '' : kr.unit ?? '')

function measuredRow(kr: Kr, got: [string, string] | string | null): { row: string; met: boolean; read?: boolean } {
  const [op, goal] = target(kr)
  const unit = kr.unit ?? ''
  const want = `${op} ${goal}${unit}`
  if (got === null) return { row: `  ${kr.name}  未测 / 目标 ${want}`, met: false }
  if (typeof got === 'string') return { row: `  ${kr.name}  量不了 / 目标 ${want} · 测量失败：${got}`, met: false }
  const line = (rag: string) =>
    `  ${kr.name}  ${shownRoundedHalfUpForDisplayOnly(got[0], unit)} / 目标 ${want} · 偏差 ${varianceText(op, got[0], goal, unit)} · ${rag} · 截至 ${monthDayElseAsWritten(got[1])}`
  const why = kr.max_age_days !== undefined ? whyTooOldByLocalDate(got[1], kr.max_age_days) : ''
  if (why) return { row: `${line('黄')}  ${why}`, met: false }
  const read = true
  const { green, pointMet, interval } = greenOf(op, goal, greenUnitOf(kr), { value: got[0], source: got[1] })
  return { row: line(green ? '绿' : pointMet && interval ? `未定（区间 [${interval[0]}, ${interval[1]}]）` : '红'), met: green, read }
}

export async function run(root: string, timeout = MEASURE_READS_RESULTS_NEVER_RUNS_AN_EVAL_TIMEOUT) {
  const objectives = await defs(root)
  const head = (await git(root, 'log', '-1', '--format=%h %cs', '--', OKR_FILE)) || NOT_COMMITTED
  const dirty = (await git(root, 'status', '--porcelain', '--', OKR_FILE)) ? '（有未提交改动）' : ''
  const out = [`OKR · 定义 ${OKR_FILE} @ ${head}${dirty}`]
  const readings: Reading[] = []
  const live = new Map<string, { met: boolean; read: boolean }>()
  for (const o of objectives) {
    const rows = []
    let met = 0
    for (const kr of o.kr ?? []) {
      const got = kr.measure ? await measure(root, kr.measure, timeout) : null
      const kept = await keptReadingOrFailure(root, o, kr, got)
      if (kept) readings.push(kept)
      const r = measuredRow(kr, got)
      live.set(`${o.name}\0${kr.name}`, { met: r.met, read: r.read === true && kept !== null && kept.value !== FAILED })
      met += Number(r.met)
      rows.push(r.row)
    }
    out.push(`O ${o.name} · ${met}/${rows.length} 达标`, ...rows)
  }
  return { text: out.join('\n'), readings, live, commit: head === NOT_COMMITTED ? undefined : head.split(' ')[0] }
}

function latestAsOfPerRound(readingsByAsOf: KeptReading[]) {
  const rounds = new Map<Round, KeptReading>()
  for (const r of readingsByAsOf) rounds.set(r.measured_at, r)
  return rounds
}

const WILSON_Z = 1.96
const PLACES_THAT_HIDE_FLOAT_DUST = 9
const toNinePlaces = (x: number) => Number(x.toFixed(PLACES_THAT_HIDE_FLOAT_DUST))
const SAMPLE_SIZE = /(?:^|\s)n=(\d+)(?=\s|$)/
const SAME_COMMIT_RERUN_SPREAD = /(?:^|\s)aa=(\d+(?:\.\d+)?)(?=\s|$)/
const AA_SPREADS_A_CHANGE_MUST_CLEAR = 2

export function sampleOf(unit: string, r: Pick<KeptReading, 'source'>) {
  const n = Number(SAMPLE_SIZE.exec(r.source)?.[1] ?? 0)
  const aa = Number(SAME_COMMIT_RERUN_SPREAD.exec(r.source)?.[1] ?? 0)
  return unit === '%' && n > 0 ? { n, aa } : { n: null, aa: 0 }
}

export function wilson(percent: number, n: number, z = WILSON_Z): [number, number] {
  const p = percent / 100
  const centre = (p + (z * z) / (2 * n)) / (1 + (z * z) / n)
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n)
  return [Math.max(0, toNinePlaces(100 * (centre - half))), Math.min(100, toNinePlaces(100 * (centre + half)))]
}

function greenOf(op: string, goalText: string, unit: string, r: Pick<KeptReading, 'value' | 'source'>) {
  const pointMet = meets(op, dec(r.value), dec(goalText))
  const { n } = sampleOf(unit, r)
  if (n === null) return { green: pointMet, pointMet, interval: null }
  const [lo, hi] = wilson(Number(r.value), n)
  const goal = Number(goalText)
  const bound = WANTS_MORE.has(op) ? lo : hi
  const green = op === '==' ? pointMet && lo <= goal && goal <= hi : meets(op, dec(bound.toFixed(9)), dec(goalText))
  return { green, pointMet, interval: [Number(lo.toFixed(1)), Number(hi.toFixed(1))] as [number, number] }
}

function noiseGate(unit: string, prev: KeptReading, cur: KeptReading) {
  const [a, b] = [sampleOf(unit, prev), sampleOf(unit, cur)]
  if (a.n === null || b.n === null) return 0
  const oneItem = 100 / Math.min(a.n, b.n)
  return toNinePlaces(Math.max(AA_SPREADS_A_CHANGE_MUST_CLEAR * Math.max(a.aa, b.aa), oneItem))
}

type Verdict = '符合' | '未定' | '不符'
const WANTS_MORE = new Set(['>=', '>'])

function headingOfAnOldDeclaration(op: string, goal: ExactDecimalAsTheOldClisDecimal, i: Declared): Heading {
  if (i.dir === '=') return 'hold'
  const numbers = [i.before, i.after].map((v) => v?.replace(/%$/, '').trim())
  if (numbers.every((v) => v && /^-?\d+(?:\.\d+)?$/.test(v))) {
    const moved = movementTowardTarget(op, goal, dec(numbers[0]!), dec(numbers[1]!))
    return moved === 'closer' ? 'toward' : moved === 'away' ? 'away' : 'hold'
  }
  const up = i.dir === '↑'
  return op === '==' || up === WANTS_MORE.has(op) ? 'toward' : 'away'
}

function verdictOf(heading: Heading, towardBy: number, gate: number): Verdict {
  const cleared = (d: number) => d > 0 && d >= gate
  if (heading === 'hold') return cleared(-towardBy) ? '不符' : '符合'
  const signed = heading === 'toward' ? towardBy : -towardBy
  return cleared(signed) ? '符合' : cleared(-signed) ? '不符' : '未定'
}

function towardTargetBy(op: string, goal: ExactDecimalAsTheOldClisDecimal, prev: KeptReading, cur: KeptReading) {
  const [before, after, e] = align(distanceToTarget(op, goal, dec(prev.value)), distanceToTarget(op, goal, dec(cur.value)))
  return toNinePlaces(Number(before - after) * 10 ** e)
}

const judgedAtAll = (i: Declared) => !i.late && i.change === 'product'
const resultOrDeclaredAt = (i: Declared) => i.result_at ?? i.declared_at

function verdictBetween(op: string, goal: ExactDecimalAsTheOldClisDecimal, unit: string, heading: Heading, prev: KeptReading, cur: KeptReading) {
  const gate = noiseGate(unit, prev, cur)
  const exactly = { closer: 1, away: -1, flat: 0 }[movementTowardTarget(op, goal, dec(prev.value), dec(cur.value))]
  return verdictOf(heading, gate === 0 ? exactly : towardTargetBy(op, goal, prev, cur), gate)
}

function judgedOnce(op: string, goal: ExactDecimalAsTheOldClisDecimal, unit: string, readings: KeptReading[], i: Declared) {
  if (!judgedAtAll(i) || i.heading === null || i.result_at === null || (i.def_hash !== null && i.def_hash !== readings[0]?.def_hash)) return null
  const rounds = latestAsOfPerRound(readings)
  const times = [...rounds.keys()].sort()
  const registeredAgainst = times.findLast((t) => t <= i.declared_at)
  const by = times.find((t) => t > i.result_at!)
  if (registeredAgainst === undefined || by === undefined) return null
  return { by, heading: i.heading, verdict: verdictBetween(op, goal, unit, i.heading, rounds.get(registeredAgainst)!, rounds.get(by)!) }
}

function declarationsSinceLastRoundAndTheirVerdicts(op: string, goal: ExactDecimalAsTheOldClisDecimal, unit: string, readings: KeptReading[], declared: Declared[]) {
  const rounds = latestAsOfPerRound(readings)
  const times = [...rounds.keys()].sort()
  const last = times.at(-1) ?? ''
  const headingOf = (i: Declared) => i.heading ?? headingOfAnOldDeclaration(op, goal, i)
  const pending = declared
    .filter((i) => (i.heading !== null && i.result_at === null) || resultOrDeclaredAt(i) >= last)
    .map((i) => ({ ticket: i.ticket, declared: headingOf(i), change: i.change, late: i.late, before: i.before, after: i.after, basis: i.basis, at: withoutTieBreak(i.declared_at) }))
  const verdicts = new Map<string, { ticket: string; dir: string; declared: Heading; verdict: Verdict }>()
  for (const i of declared) {
    const judged = judgedOnce(op, goal, unit, readings, i)
    if (judged?.by !== last) continue
    verdicts.set(i.ticket, { ticket: i.ticket, dir: i.dir ?? judged.heading, declared: judged.heading, verdict: judged.verdict })
  }
  const all = [...verdicts.values()]
  return {
    pending,
    verdicts: all.map(({ ticket, declared, verdict }) => ({ ticket, declared, verdict })),
    mismatch: all.filter((v) => v.verdict === '不符').map(({ ticket, dir }) => ({ ticket, dir })),
  }
}

type Attention = { kind: 'five' | 'stuck' | 'wait' | 'accept' | 'breach'; objective: string; kr: string | null; text: string }
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const withoutTieBreak = (at: string) => at.split('~')[0]!

const sameReading = (a: KeptReading, b: KeptReading) => a.value === b.value && a.as_of === b.as_of && a.source === b.source && a.def_hash === b.def_hash

function roundsOf(kept: KeptReading[]) {
  const readings = kept.filter((r) => r.value !== FAILED)
  return readings.filter((r, i) => i === 0 || !sameReading(readings[i - 1]!, r))
}

function roundsAndCurrentSeries(kept: KeptReading[]) {
  const starts = kept.flatMap((r, i) => (i === 0 || kept[i - 1]!.def_hash !== r.def_hash ? [i] : []))
  return { rounds: roundsOf(kept), series: starts.length ? roundsOf(kept.slice(starts.at(-1))) : [], version: starts.length }
}

function missedRoundsSinceLastMet(rs: KeptReading[], ok: (r: KeptReading) => boolean) {
  let missed = 0
  for (const r of [...rs].reverse()) {
    if (ok(r)) break
    missed++
  }
  return missed
}

function statusOnlyTheLatestReadingGoesStale(kr: Kr, last: KeptReading | undefined, missed: number, pointMetButNotTheInterval: boolean) {
  if (!last) return 'untested'
  if (kr.max_age_days !== undefined && whyTooOldByLocalDate(last.as_of, kr.max_age_days)) return 'stale'
  return pointMetButNotTheInterval ? 'undecided' : missed ? 'missed' : 'met'
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
    objectives: [] as { name: string; met: number; total: number; committed: { met: number; total: number }; aspirational_score: number | null; done: boolean; accept_pending: boolean; impacts: Record<Heading, number>; rulers: number; krs: { name: string; mismatch: { ticket: string; dir: string }[] }[] }[],
    attention: [] as Attention[],
  }
  for (const o of objectives) {
    const name = o.name
    const krs = []
    const counts = { toward: 0, away: 0, hold: 0 }
    const rulers = new Set<string>()
    const exactScores = new Map<string, Fraction>()
    let missedSinceAccept = false
    for (const kr of o.kr ?? []) {
      const [op, goalText] = target(kr)
      const goal = dec(goalText)
      const kept = byKr.get(kr.name) ?? []
      const { rounds, series: rs, version } = roundsAndCurrentSeries(kept)
      const failure = kept.at(-1)?.value === FAILED ? kept.at(-1)!.source : null
      const unit = kr.unit ?? ''
      const ok = (r: KeptReading) => greenOf(op, goalText, greenUnitOf(kr), r).green
      const missed = missedRoundsSinceLastMet(rs, ok)
      const last = rs.at(-1)
      const lastGreen = last ? greenOf(op, goalText, greenUnitOf(kr), last) : null
      const pointMetButNotTheInterval = lastGreen !== null && !lastGreen.green && lastGreen.pointMet
      const status = failure !== null ? 'unmeasurable' : statusOnlyTheLatestReadingGoesStale(kr, last, missed, pointMetButNotTheInterval)
      const trends = rs.slice(1).map((r, i) => movementTowardTarget(op, goal, dec(rs[i]!.value), dec(r.value)))
      const accepted = accepts.get(name)
      missedSinceAccept ||= accepted !== undefined && rounds.some((r) => r.measured_at > accepted && !ok(r))
      if (kr.kind !== 'committed') exactScores.set(kr.name, scoreOf(op, goal, status, rs, kr.baseline))
      const { pending, verdicts, mismatch } = declarationsSinceLastRoundAndTheirVerdicts(op, goal, unit, rs, declared.get(`${name}\0${kr.name}`) ?? [])
      for (const i of pending) {
        if (i.late) continue
        if (i.change === 'product') counts[i.declared]++
        else rulers.add(i.ticket)
      }
      krs.push({
        name: kr.name,
        target: `${op} ${goalText}`,
        target_op: op,
        target_value: Number(goalText),
        unit,
        status,
        kind: kr.kind === 'committed' ? 'committed' : 'aspirational',
        score: kr.kind === 'committed' ? null : shown(exactScores.get(kr.name)!),
        n: last ? sampleOf(unit, last).n : null,
        interval: lastGreen?.interval ?? null,
        value: last ? Number(last.value) : null,
        as_of: last?.as_of ?? null,
        source: last?.source ?? null,
        history: rs.slice(-READINGS_SHOWN).map((r) => ({ value: Number(r.value), as_of: r.as_of })),
        trend: trends.at(-1) ?? null,
        missed_rounds: missed,
        wait: kr.wait ?? null,
        impacts: pending,
        verdicts,
        mismatch,
        failure,
        series: rs.length ? { version, since: withoutTieBreak(rs[0]!.measured_at).slice(0, 10), def_hash: rs[0]!.def_hash } : null,
      })
      out.attention.push(...attentionEvenWhenStale(name, kr, op, goalText, status, missed, trends, rs))
      if (kr.kind === 'committed' && status === 'missed') {
        out.attention.push({ kind: 'breach', objective: name, kr: kr.name, text: `${name} · ${kr.name} 承诺型破线：${last!.value}${unit} 对目标 ${op} ${goalText}${unit}` })
      }
    }
    const met = krs.filter((k) => k.status === 'met').length
    const committed = krs.filter((k) => k.kind === 'committed')
    const scored = krs.filter((k) => k.kind === 'aspirational' && k.wait === null).map((k) => exactScores.get(k.name)!)
    const sum = scored.reduce(plus, ZERO)
    const aspirationalScore = scored.length ? shown({ num: sum.num, den: sum.den * BigInt(scored.length) }) : null
    const bar = fractionOf(ASPIRATIONAL_DONE_SCORE)
    const reachesTheBar = sum.num * bar.den >= bar.num * BigInt(scored.length) * sum.den
    const everyCountedKrReads = krs.filter((k) => k.kind === 'committed' || k.wait === null).every((k) => !UNSCORED_STATUSES.has(k.status))
    const done = committed.length + scored.length > 0 && committed.every((k) => k.status === 'met') && everyCountedKrReads && reachesTheBar
    const pending = done && (!accepts.has(name) || missedSinceAccept)
    const scoreText = aspirationalScore === null ? '' : `、进取型均分 ${aspirationalScore.toFixed(SCORE_PLACES)}`
    if (pending) out.attention.push({ kind: 'accept', objective: name, kr: null, text: `${name} 承诺型全过${scoreText}，待你验收（nawaban okr --accept）` })
    out.objectives.push({
      name,
      met,
      total: krs.length,
      committed: { met: committed.filter((k) => k.status === 'met').length, total: committed.length },
      aspirational_score: aspirationalScore,
      done,
      accept_pending: pending,
      impacts: counts,
      rulers: rulers.size,
      krs,
    })
    out.met += met
    out.total += krs.length
  }
  return out
}

export function impactText(data: ReturnType<typeof judge>) {
  const out = []
  for (const o of data.objectives) {
    const n = o.impacts
    const rulers = o.rulers ? ` · 改尺子 ${o.rulers} 张` : ''
    if (Object.values(n).some(Boolean) || o.rulers) out.push(`O ${o.name} · 声明 向目标 ${n.toward} 背离 ${n.away} 不变 ${n.hold}${rulers}`)
    for (const k of o.krs) if (k.mismatch.length) out.push(`  预期不符 ${k.name}：` + k.mismatch.map((m) => `${m.ticket} 声明 ${HEADING_WORDS[m.dir as Heading] ?? m.dir}`).join('、'))
  }
  return out.join('\n')
}

const HEADING_WORDS: Record<Heading, string> = { toward: '向目标', away: '背离', hold: '不变' }

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
  const latestResume = new Map<string, string>()
  const rounds: OkrRound[] = []
  const latestPer = (map: Map<string, string>, m: MessageView, o: string) => {
    if (onTheOneClock(m) > (map.get(o) ?? '')) map.set(o, onTheOneClock(m))
  }
  for (const thread of await wholeThreadsRootFirst(team, okrChannel(project))) {
    for (const m of thread) {
      rows.push(...keptOf(m))
      for (const d of blocksOf(m, 'nawaban-okr-accept')) latestPer(latestAccept, m, d.objective as string)
      for (const d of blocksOf(m, 'nawaban-okr-resume')) latestPer(latestResume, m, d.objective as string)
      for (const d of blocksOf(m, 'nawaban-okr-round')) rounds.push({ at: onTheOneClock(m), n: d.n as number, kept: d.kept as number, moved: d.moved as string[], done: (d.done as string[]) ?? [] })
    }
  }
  rounds.sort((a, b) => order(a.at, b.at))
  const declared = new Map<string, Declared[]>()
  for (const thread of await wholeThreadsRootFirst(team, project, 'nawaban-impact')) {
    for (const [k, d] of declaredOnOneTicket(thread)) declared.set(k, [...(declared.get(k) ?? []), d])
  }
  for (const list of declared.values()) list.sort((a, b) => order(a.declared_at, b.declared_at))
  return { rows, accepts: latestAccept, resumes: latestResume, rounds, declared }
}

function declaredOnOneTicket([root, ...replies]: MessageView[]): Map<string, Declared> {
  const ticket = root!.labels.key ?? `#${root!.id}`
  const messages = [root!, ...replies]
  const firstPullRequestAt = messages.find((m) => blocksOf(m, 'nawaban-link').some((d) => d.kind === 'pr'))
  const lateAfter = firstPullRequestAt ? onTheOneClock(firstPullRequestAt) : null
  const results = new Map<string, { after: string; basis: string; at: Round }>()
  for (const m of messages) for (const d of blocksOf(m, 'nawaban-impact-result')) for (const r of d.krs as { name: string; after: string; basis: string }[]) results.set(r.name, { ...r, at: onTheOneClock(m) })
  const out = new Map<string, Declared>()
  for (const m of messages) {
    const at = onTheOneClock(m)
    for (const d of blocksOf(m, 'nawaban-impact')) {
      for (const kr of d.krs as { name: string; dir: string; before?: string; after?: string; basis?: string }[]) {
        if (out.has(`${d.objective}\0${kr.name}`)) continue
        const old = { dir: kr.dir, heading: null, change: 'product' as const, late: true, before: kr.before ?? null, after: kr.after ?? null, basis: kr.basis ?? null, def_hash: null, result_at: null }
        out.set(`${d.objective}\0${kr.name}`, { ticket, ...old, declared_at: at })
      }
    }
    for (const d of blocksOf(m, 'nawaban-impact', 2)) {
      for (const kr of d.krs as { name: string; heading: Heading; reading?: string; def_hash?: string }[]) {
        const k = `${d.objective}\0${kr.name}`
        if (out.has(k) && !out.get(k)!.late) continue
        const result = results.get(kr.name)
        out.set(k, {
          ticket,
          dir: null,
          heading: kr.heading,
          change: d.change as Change,
          late: lateAfter !== null && at > lateAfter,
          before: kr.reading ?? null,
          after: result?.after ?? null,
          basis: result?.basis ?? null,
          def_hash: kr.def_hash ?? null,
          declared_at: at,
          result_at: result?.at ?? null,
        })
      }
    }
  }
  return out
}

export async function registeredReadings(team: Team, project: string, krs: string[]) {
  const kept = (await wholeThreadsRootFirst(team, okrChannel(project))).flat().flatMap(keptOf)
  const latestOf = (kr: string) => kept.filter((r) => r.kr === kr).sort((a, b) => order(a.measured_at, b.measured_at)).at(-1)
  return Object.fromEntries(
    krs.map((kr) => {
      const latest = latestOf(kr)
      const reading = latest && latest.value !== FAILED ? { reading: latest.value } : {}
      return [kr, latest?.def_hash ? { ...reading, def_hash: latest.def_hash } : reading]
    }),
  ) as Record<string, { reading?: string; def_hash?: string }>
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
  return (await keepEachNewReadingOnceNamingTheKrs(team, project, readings, commit)).length
}

async function keepEachNewReadingOnceNamingTheKrs(team: Team, project: string, readings: Reading[], commit?: string) {
  const kept: string[] = []
  for (const r of readings) {
    const thread = key(project, r.kr)
    const def_hash = r.def_hash ?? ''
    const latest = await latestKept(team, thread)
    if (latest && sameReading(latest, { ...r, def_hash, measured_at: '' })) continue
    await keepAs(team, project, r, key(project, r.kr, latest?.id ?? '', r.value, r.as_of, r.source, def_hash), commit)
    if (r.value !== FAILED) kept.push(r.kr)
  }
  return kept
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

async function acceptAfterThisRunsReadingsSoNoneCountsAsAMissSince(team: Team, project: string, objective: string, done: Map<string, boolean>, kept: number) {
  if (!done.get(objective)) {
    throw new Refused(`${done.has(objective) ? `${objective} 还没收工(承诺型全过、进取型均分 ≥ ${ASPIRATIONAL_DONE_SCORE}),不收 accept` : `没有这个 O:${objective}`}(读数新记 ${kept} 条)`)
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
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { accept: { type: 'string' }, resume: { type: 'string' } } })
    if (positionals.length) throw new Refused('usage: nawaban okr [--accept <O>] [--resume <O>]', 2)
    const top = await git(cwd, 'rev-parse', '--show-toplevel')
    if (!top) throw new Refused('okr 要在 git 仓库里跑')
    if (await keptByTheOldCli(top)) throw new Refused('这个仓库还在旧 CLI 记账(hooks/route.mjs 说 old):板 CLI 的 okr 会另记一本面板不读的账,改用旧 CLI 跑 okr')
    const repo = (await mainCheckout(top))!
    const project = await projectOf(dir, repo)
    if (values.resume !== undefined) {
      if (!project) throw new Refused(`仓库 ${repo} 不在 ${join(dir, 'repos.json')},记不了 resume`)
      await resumeOnceADecisionOnItWasResolved(team, project, await defs(repo), values.resume)
    }
    const { text, readings, live, commit } = await run(top, timeout)
    process.stdout.write(text + '\n')
    if (!project) {
      if (values.accept === undefined) {
        process.stderr.write(`(仓库 ${repo} 不在 ${join(dir, 'repos.json')},读数没记)\n`)
        return 0
      }
      throw new Refused(`仓库 ${repo} 不在 ${join(dir, 'repos.json')},记不了 accept`)
    }
    const kept = await keepEachNewReadingOnceNamingTheKrs(team, project, readings, commit)
    const objectives = await defs(repo)
    const before = await load(team, project)
    const thisRunAgrees = (name: string) =>
      (objectives.find((y) => y.name === name)?.kr ?? []).every((kr) => {
        const now = live.get(`${name}\0${kr.name}`)
        return (kr.wait !== undefined && kr.kind !== 'committed') || (now?.read === true && (kr.kind !== 'committed' || now.met))
      })
    const doneNow = judge(objectives, before.rows, before.accepts, before.declared, repo, null).objectives.filter((x) => x.done && thisRunAgrees(x.name)).map((x) => x.name)
    const round = { n: before.rounds.length + 1, kept: kept.length, moved: movedTowardTheirTarget(objectives, before.rows, kept), done: doneNow }
    await team.post(okrChannel(project), block('nawaban-okr-round@1', round))
    if (values.accept !== undefined) {
      const atThisRound = await load(team, project)
      const o = objectives.find((x) => x.name === values.accept)
      if (o && hardStop(o, atThisRound.rounds, later(atThisRound.accepts.get(o.name), atThisRound.resumes.get(o.name)))) {
        throw new Refused(`${o.name} 硬停中,不收 accept:待决策项 resolve 之后先跑 okr --resume ${o.name}(读数新记 ${kept.length} 条)`)
      }
      const judged = judge(objectives, atThisRound.rows, atThisRound.accepts, atThisRound.declared, repo, null).objectives
      const done = new Map(judged.map((x) => [x.name, x.done && thisRunAgrees(x.name)]))
      await acceptAfterThisRunsReadingsSoNoneCountsAsAMissSince(team, project, values.accept, done, kept.length)
    }
    process.stdout.write(`第 ${round.n} 轮${round.kept ? '' : '(空转)'} · 读数新记 ${kept.length} 条${values.accept !== undefined ? ` · ✓ accept ${values.accept}` : ''}\n`)
    const { rows, accepts, resumes, rounds, declared } = await load(team, project)
    const data = judge(objectives, rows, accepts, declared, repo, null)
    const lines = [standingText(data), impactText(data)].filter(Boolean).join('\n')
    if (lines) process.stdout.write(lines + '\n')
    let stopped = false
    for (const o of objectives) {
      const start = later(accepts.get(o.name), resumes.get(o.name))
      const stop = hardStop(o, rounds, start)
      if (!stop) continue
      const draft = join(dir, 'okr-stop', `${project}-${o.name}.md`)
      await mkdir(join(dir, 'okr-stop'), { recursive: true })
      await writeFile(draft, decisionDraft(o, stop, start, rows, declared))
      process.stdout.write(`硬停：${o.name}(${stop.why})· 待决策项草稿 ${draft},补上「建议」后用 event --kind ask 发;决策者 resolve 之后跑 okr --resume ${o.name}\n`)
      stopped = true
    }
    return stopped ? HARD_STOP_EXIT : 0
  } catch (error) {
    return exitCodeOfRefusalOrBoardError(error)
  }
}

async function resumeOnceADecisionOnItWasResolved(team: Team, project: string, objectives: Objective[], name: string) {
  const o = objectives.find((x) => x.name === name)
  if (!o) throw new Refused(`没有这个 O:${name}`)
  const { accepts, resumes, rounds } = await load(team, project)
  const stop = hardStop(o, rounds, later(accepts.get(name), resumes.get(name)))
  if (!stop) throw new Refused(`${name} 没在硬停,不用 --resume`)
  if (!(await resolvedDecisionOn(team, project, o, stop.at))) {
    throw new Refused(`${name} 硬停之后还没有 resolve 过的待决策项(挂在这个 O 或它的 KR 上),--resume 不收`)
  }
  await team.post(okrChannel(project), block('nawaban-okr-resume@1', { objective: name }))
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

const isAspirational = (kr: Kr) => kr.kind !== 'committed'
const later = (a: string | undefined, b: string | undefined) => ((a ?? '') > (b ?? '') ? a ?? '' : b ?? '')

export function hardStop(o: Objective, rounds: OkrRound[], sprintStart: string) {
  const aspirational = new Set((o.kr ?? []).filter(isAspirational).map((k) => k.name))
  const sprint = rounds.filter((r) => r.at > sprintStart)
  const still = (r: OkrRound) => !r.done.includes(o.name) && !r.moved.some((k) => aspirational.has(k))
  for (let i = 0; i < sprint.length; i++) {
    if (sprint[i]!.done.includes(o.name)) continue
    if (i + 1 >= STILL_ROUNDS_TO_STOP && sprint.slice(i + 1 - STILL_ROUNDS_TO_STOP, i + 1).every(still)) {
      return { why: `连续 ${STILL_ROUNDS_TO_STOP} 轮没有进取型 KR 往目标动`, sprint, at: sprint[i]!.at }
    }
    if (i + 1 >= SPRINT_ROUNDS_TO_STOP) return { why: `冲刺满 ${SPRINT_ROUNDS_TO_STOP} 轮还没收工`, sprint, at: sprint[i]!.at }
  }
  return null
}

function currentSeriesOf(rows: KeptReading[], kr: string) {
  return roundsAndCurrentSeries(rows.filter((r) => r.kr === kr).sort((a, b) => order(a.measured_at, b.measured_at))).series
}

function movedTowardTheirTarget(objectives: Objective[], rows: KeptReading[], kept: string[]) {
  return objectives.flatMap((o) =>
    (o.kr ?? []).flatMap((kr) => {
      if (!kept.includes(kr.name)) return []
      const rs = currentSeriesOf(rows, kr.name)
      if (rs.length < 2) return []
      const [op, goalText] = target(kr)
      return verdictBetween(op, dec(goalText), kr.unit ?? '', 'toward', rs.at(-2)!, rs.at(-1)!) === '符合' ? [kr.name] : []
    }),
  )
}

export function decisionDraft(o: Objective, stop: NonNullable<ReturnType<typeof hardStop>>, sprintStart: string, rows: KeptReading[], declared: Map<string, Declared[]>) {
  const still = (o.kr ?? []).filter((kr) => isAspirational(kr) && !stop.sprint.some((r) => r.moved.includes(kr.name))).map((kr) => kr.name)
  const since = withoutTieBreak(stop.sprint[0]?.at ?? sprintStart).slice(0, 10)
  const tried = (o.kr ?? []).flatMap((kr) => {
    const [op, goalText] = target(kr)
    const rs = currentSeriesOf(rows, kr.name)
    return (declared.get(`${o.name}\0${kr.name}`) ?? [])
      .filter((i) => i.declared_at > sprintStart)
      .map((i) => {
        const judged = judgedOnce(op, dec(goalText), kr.unit ?? '', rs, i)
        const why = i.late ? '事后，不判' : i.change !== 'product' ? '改尺子，不判' : judged ? judged.verdict : '还没判'
        return `  - ${i.ticket} ${kr.name} ${HEADING_WORDS[i.heading ?? 'hold']}：${why}`
      })
  })
  const readings = (o.kr ?? []).map((kr) => {
    const rs = currentSeriesOf(rows, kr.name)
    const inSprint = rs.filter((r) => r.measured_at > sprintStart)
    return `  - ${kr.name}（目标 ${kr.target}）：${inSprint.map((r) => `${r.value}（${r.as_of}）`).join(' → ') || '没有读数'}`
  })
  return [
    `决策事项：${o.name} 下一步怎么走`,
    `关联 KR：${(still.length ? still : (o.kr ?? []).map((k) => k.name)).join('、')}`,
    `背景：硬停，${stop.why}。这个冲刺自 ${since} 起 ${stop.sprint.length} 轮（${stop.sprint.map((r) => `第 ${r.n} 轮${r.kept ? '' : '空转'}`).join('、')}）。`,
    '  冲刺内声明过的票：',
    ...(tried.length ? tried : ['  - 没有']),
    '  各 KR 的读数：',
    ...readings,
    '备选方案：',
    `- 换打法继续 ｜ 再开一个冲刺，${still.join('、') || '这些 KR'} 换一种做法；前两轮的做法没让它们动 ｜ 双向门`,
    '- 降目标（只有你能定） ｜ 改 okr.toml 的 target，O 更容易收工，标准跟着降 ｜ 双向门',
    '- 改量法或数据集（只有你能定） ｜ 开新序列，分数从 0 重算，前后读数不能直接比 ｜ 双向门',
    '建议：',
    '',
  ].join('\n')
}

async function resolvedDecisionOn(team: Team, project: string, o: Objective, since: string) {
  const names = new Set([o.name, ...(o.kr ?? []).map((k) => k.name)])
  for (const thread of await wholeThreadsRootFirst(team, project, 'nawaban-ask')) {
    let askedOnIt = false
    for (const m of thread) {
      const asks = blocksOf(m, 'nawaban-ask')
      if (asks.length) askedOnIt = asks.some((d) => String(d.kr).split(KR_LIST_SEPARATOR).some((k) => names.has(k.trim())))
      else if (askedOnIt && onTheOneClock(m) > since && blocksOf(m, 'nawaban-resolve').length) return true
    }
  }
  return false
}

const KR_LIST_SEPARATOR = /[、,，]/

const ROUTE = join(import.meta.dirname, '../../hooks/route.mjs')

async function keptByTheOldCli(top: string) {
  const { stdout } = await promisify(execFile)(process.execPath, [ROUTE, top])
  return stdout.trim() === 'old'
}

const UNSCORED_STATUSES = new Set(['untested', 'unmeasurable', 'stale'])

type Fraction = { num: bigint; den: bigint }
const DISPLAY_SCALE = 10n ** 12n
const ZERO: Fraction = { num: 0n, den: 1n }
const ONE: Fraction = { num: 1n, den: 1n }
const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b))
const plus = (a: Fraction, b: Fraction): Fraction => {
  const num = a.num * b.den + b.num * a.den
  const den = a.den * b.den
  const g = gcd(num, den) || 1n
  return { num: num / g, den: den / g }
}
const shown = (f: Fraction) => Number((f.num * DISPLAY_SCALE) / f.den) / Number(DISPLAY_SCALE)
const fractionOf = (x: number): Fraction => {
  const d = dec(String(x))
  return d.e >= 0 ? { num: d.n * 10n ** BigInt(d.e), den: 1n } : { num: d.n, den: 10n ** BigInt(-d.e) }
}

function scoreOf(op: string, goal: ExactDecimalAsTheOldClisDecimal, status: string, series: KeptReading[], baseline?: string): Fraction {
  if (status === 'met') return ONE
  if (UNSCORED_STATUSES.has(status) || !series.length) return ZERO
  const distance = (value: string): ExactDecimalAsTheOldClisDecimal => {
    const [v, g, e] = align(dec(value), goal)
    const d = WANTS_MORE.has(op) ? g - v : op === '==' ? (v > g ? v - g : g - v) : v - g
    return { n: d > 0n ? d : 0n, e }
  }
  const [d0, d] = align(distance(baseline?.trim() ?? series[0]!.value), distance(series.at(-1)!.value))
  if (d0 === 0n) return ZERO
  const gained = d0 - d
  return gained <= 0n ? ZERO : gained >= d0 ? ONE : { num: gained, den: d0 }
}

export function standingText(data: ReturnType<typeof judge>) {
  return data.objectives
    .map((o) => {
      const parts = [...(o.committed.total ? [`承诺 ${o.committed.met}/${o.committed.total}`] : []), ...(o.aspirational_score === null ? [] : [`进取均分 ${o.aspirational_score.toFixed(SCORE_PLACES)}`])]
      const why = o.committed.met < o.committed.total ? '承诺型没全过' : `进取均分要 ≥ ${ASPIRATIONAL_DONE_SCORE}`
      const breaches = data.attention.filter((a) => a.kind === 'breach' && a.objective === o.name).map((a) => `  破线 ${a.text}`)
      return parts.length ? [`O ${o.name} · ${parts.join(' · ')} · ${o.done ? '收工' : `未收工(${why})`}`, ...breaches].join('\n') : ''
    })
    .filter(Boolean)
    .join('\n')
}
