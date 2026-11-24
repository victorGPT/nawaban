import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { callsOfStep, commandsRunBy, quotesBlanked, stepTime, TOOLS_THAT_EDIT, type Call } from './progress.ts'

export type Narrated = { at: number; kind: 'said' | 'edited' | 'tested'; text: string }
export type Hold = { by: string; from: number; to: number | null }
type Happening = { at: number; kind: 'said'; text: string } | { at: number; kind: 'edited'; path: string; text: string } | { at: number; kind: 'tested' }
type Step = Record<string, any>

const TESTING_OR_BUILDING =
  /\b(vitest|jest|pytest|unittest|ctest|cargo\s+(?:test|check|clippy|build)|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)|swift\s+(?:build|test)|xcodebuild|tsc\b|run-tests|just\s+(?:t|l|test|check)|make\s+(?:test|check|build))\b/
const TESTED_WORDS = '在跑测试 / 检查'
const SECONDS_BETWEEN_TESTED_ROWS = 15
const SESSION_PROFILE = /^(cc|cx)-([0-9a-f]{8})$/
const CODE_MODE_WRAPPER = 'REPL'
const CODEX_STEPS_NAMING_THE_CWD = new Set(['session_meta', 'turn_context'])
const MARKDOWN_CODE = /`([^`\n]+)`/g
const MARKDOWN_BOLD = /\*\*([^*\n]+)\*\*/g

const saidPlainly = (text: string) =>
  text
    .replace(MARKDOWN_CODE, '$1')
    .replace(MARKDOWN_BOLD, '$1')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')

function saidBeforeAToolCall(step: Step): string[] {
  if (step.type === 'assistant' && step.message?.stop_reason === 'tool_use' && Array.isArray(step.message.content)) {
    return step.message.content.filter((c: { type?: string }) => c.type === 'text').map((c: { text?: string }) => String(c.text ?? ''))
  }
  const p = step.payload
  if (step.type === 'response_item' && p?.type === 'message' && p.role === 'assistant' && p.phase === 'commentary' && Array.isArray(p.content)) {
    return p.content.filter((c: { type?: string }) => c.type === 'output_text').map((c: { text?: string }) => String(c.text ?? ''))
  }
  return []
}

function codexItemsAsCalls(step: Step): Call[] {
  const item = step.type === 'event_msg' && step.payload?.type === 'item_completed' ? step.payload.item : null
  if (item?.type === 'CommandExecution' && Array.isArray(item.command)) return [{ name: 'exec_command', input: { cmd: String(item.command.at(-1) ?? '') } }]
  if (item?.type === 'FileChange' && item.changes && typeof item.changes === 'object') return [{ name: 'apply_patch', input: { paths: Object.keys(item.changes) } }]
  return []
}

const pathsEditedBy = ({ input }: Call) => [input.file_path, input.path, input.notebook_path, ...(Array.isArray(input.paths) ? input.paths : [])].filter((p): p is string => typeof p === 'string' && p !== '')

function shownFrom(cwd: string | undefined, path: string) {
  if (!cwd || !isAbsolute(path)) return path
  const inside = relative(cwd, path)
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : basename(path)
}

function happeningsOfCall(call: Call, at: number, cwd: string | undefined): Happening[] {
  if (call.name === CODE_MODE_WRAPPER) return []
  const edited: Happening[] = TOOLS_THAT_EDIT.has(call.name) ? pathsEditedBy(call).map((path) => ({ at, kind: 'edited', path: resolve(cwd ?? '/', path), text: shownFrom(cwd, path) })) : []
  const tested = commandsRunBy(call).some((command) => TESTING_OR_BUILDING.test(quotesBlanked(command)))
  return tested ? [...edited, { at, kind: 'tested' }] : edited
}

function happeningsOf(step: Step, cwd: string | undefined): Happening[] {
  const at = stepTime(step)
  if (at === null || step.isSidechain) return []
  const said: Happening[] = saidBeforeAToolCall(step).map(saidPlainly).filter(Boolean).map((text) => ({ at, kind: 'said', text }))
  return [...said, ...[...callsOfStep(step), ...codexItemsAsCalls(step)].flatMap((call) => happeningsOfCall(call, at, cwd))]
}

const cwdOf = (step: Step): string | undefined => step.cwd ?? (CODEX_STEPS_NAMING_THE_CWD.has(step.type) ? step.payload?.cwd : undefined)

const readTranscripts = new Map<string, { size: number; mtimeMs: number; happenings: Happening[] }>()

async function happeningsIn(transcript: string): Promise<Happening[]> {
  const { size, mtimeMs } = await stat(transcript)
  const read = readTranscripts.get(transcript)
  if (read?.size === size && read.mtimeMs === mtimeMs) return read.happenings
  const happenings: Happening[] = []
  let cwd: string | undefined
  for await (const line of createInterface({ input: createReadStream(transcript), crlfDelay: Infinity })) {
    let step: Step
    try {
      step = JSON.parse(line)
    } catch {
      continue
    }
    cwd = cwdOf(step) ?? cwd
    happenings.push(...happeningsOf(step, cwd))
  }
  readTranscripts.set(transcript, { size, mtimeMs, happenings })
  return happenings
}

function narratedRows(happenings: Happening[]): Narrated[] {
  const rows: Narrated[] = []
  let editedSinceLastSaid = new Set<string>()
  let lastTestedAt = -Infinity
  for (const h of happenings) {
    const at = Math.floor(h.at)
    if (h.kind === 'said') {
      rows.push({ at, kind: 'said', text: h.text })
      editedSinceLastSaid = new Set()
    } else if (h.kind === 'tested') {
      if (h.at - lastTestedAt < SECONDS_BETWEEN_TESTED_ROWS) continue
      rows.push({ at, kind: 'tested', text: TESTED_WORDS })
      lastTestedAt = h.at
    } else if (!editedSinceLastSaid.has(h.path)) {
      editedSinceLastSaid.add(h.path)
      const previous = rows.at(-1)
      if (previous?.kind === 'edited') previous.text += ', ' + h.text
      else rows.push({ at, kind: 'edited', text: h.text })
    }
  }
  return rows
}

const claudeProjects = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
const codexSessions = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')

export async function claudeTranscriptOf(sessionOrItsStart: string): Promise<string | null> {
  const projects = claudeProjects()
  const dirs = await readdir(projects).catch(() => [])
  const names = await Promise.all(dirs.map((dir) => readdir(join(projects, dir)).catch(() => [] as string[])))
  for (const [i, dir] of dirs.entries()) {
    const name = names[i]!.find((n) => n.startsWith(sessionOrItsStart) && n.endsWith('.jsonl'))
    if (name) return join(projects, dir, name)
  }
  return null
}

async function codexTranscriptOnlyOneSessionStartsWith(start: string): Promise<string | null> {
  const sessions = codexSessions()
  const rollout = new RegExp(`-${start}[0-9a-f-]{28}\\.jsonl$`)
  const found = (await readdir(sessions, { recursive: true }).catch(() => [] as string[])).filter((p) => rollout.test(p))
  return found.length === 1 ? join(sessions, found[0]!) : null
}

async function transcriptOfProfile(profile: string): Promise<string | null> {
  const [, agent, start] = SESSION_PROFILE.exec(profile) ?? []
  if (agent === 'cc') return claudeTranscriptOf(start!)
  if (agent === 'cx') return codexTranscriptOnlyOneSessionStartsWith(start!)
  return null
}

async function happeningsHeldBy(profile: string): Promise<Happening[]> {
  const transcript = await transcriptOfProfile(profile)
  if (!transcript) return []
  try {
    return await happeningsIn(transcript)
  } catch {
    return []
  }
}

export async function narrationOf(holds: Hold[], now = Date.now() / 1000): Promise<Narrated[]> {
  const sessions = [...new Set(holds.map((h) => h.by))]
  const happeningsOfSession = new Map(await Promise.all(sessions.map(async (by) => [by, await happeningsHeldBy(by)] as const)))
  return holds
    .flatMap(({ by, from, to }) => narratedRows(happeningsOfSession.get(by)!.filter((h) => h.at >= from && h.at < (to ?? now))))
    .sort((a, b) => a.at - b.at)
}
