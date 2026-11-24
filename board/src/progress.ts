import { execFile } from 'node:child_process'
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { promisify } from 'node:util'

export const MILESTONES = ['started', 'edited', 'committed', 'pr', 'review', 'reported'] as const
export type Milestone = (typeof MILESTONES)[number]
export type Live = { milestone: Milestone; at: number }
type HookInput = { session_id?: string; transcript_path?: string; cwd?: string }
type Held = { id: string; claimedAt: number }

const exec = promisify(execFile)
const PROGRESS_FOLDER = 'progress'
const TRANSCRIPT_TAIL_BYTES = 4 << 20
const WRITE_EVERY_SECONDS = 5 * 60
const LOOKS_AGAIN_AFTER_SECONDS = 60
const PROBE_TIMEOUT_MS = 10_000
const TOOLS_THAT_EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_to_file', 'replace_file_content'])
const AT_A_COMMAND = String.raw`(?:^|[;&|(\n]\s*)`
const COMMAND_SIGNS: [Milestone, RegExp, RegExp | null][] = [
  ['reported', new RegExp(AT_A_COMMAND + String.raw`hc\s+send\b`), /^[^\n]*回报：/],
  ['review', new RegExp(AT_A_COMMAND + String.raw`(?:gh\s+pr\s+checks\b|codex\s+review\b|node\s+\S*codex-companion\S*\s+(?:task|review))`), null],
  ['pr', new RegExp(AT_A_COMMAND + String.raw`gh\s+pr\s+create\b`), null],
  ['committed', new RegExp(AT_A_COMMAND + String.raw`git(?:\s+-[Cc]\s+\S+)*\s+commit\b`), null],
]
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g
const HEREDOC_BODY = /(<<-?\s*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?\n[ \t]*\3)(?=\n|$)/g
const blankedKeepingLength = (text: string) => text.replace(/[^\n]/g, ' ')
const quotesBlanked = (command: string) =>
  command
    .replace(HEREDOC_BODY, (_all, opener: string, _q, _tag, body: string) => opener + blankedKeepingLength(body))
    .replace(QUOTED, (q) => q[0] + ' '.repeat(q.length - 2) + q.at(-1))

function signsOf(command: string): Milestone[] {
  const blanked = quotesBlanked(command)
  return COMMAND_SIGNS.flatMap(([milestone, head, restOfTheLine]) => {
    const at = head.exec(blanked)
    return at && (!restOfTheLine || restOfTheLine.test(command.slice(at.index))) ? [milestone] : []
  })
}
const REVIEWER_AGENT = /codex/i
const SCRIPT_THAT_EDITS = /\b(?:edit|write)\(/
const SHELL_IN_A_SCRIPT = /\$`([^`]*)`/g

export const progressDir = (boardDir: string) => join(boardDir, PROGRESS_FOLDER)
export const liveFile = (boardDir: string, taskId: string) => join(progressDir(boardDir), `${taskId}.json`)
const STAMP_FOLDER = 'progress-stamps'
const sessionStamp = (boardDir: string, session: string) => join(boardDir, STAMP_FOLDER, session)
export const isLiveFileName = (name: string) => /^\d+\.json$/.test(name)
const rank = (m: Milestone) => MILESTONES.indexOf(m)
const furthest = (ms: Milestone[]) => ms.reduce((a, b) => (rank(b) > rank(a) ? b : a), 'started' as Milestone)

export function readLive(boardDir: string, taskId: string): Live | null {
  try {
    const live = JSON.parse(readFileSync(liveFile(boardDir, taskId), 'utf8'))
    return MILESTONES.includes(live.milestone) && typeof live.at === 'number' ? live : null
  } catch {
    return null
  }
}

export const forgetLive = (boardDir: string, taskId: string) => rm(liveFile(boardDir, taskId), { force: true })

function tailLines(path: string): string[] {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    return buf.toString('utf8').split('\n')
  } finally {
    closeSync(fd)
  }
}

type Call = { name: string; input: Record<string, unknown> }

const parsedOrEmpty = (json: unknown): Record<string, unknown> => {
  if (json && typeof json === 'object') return json as Record<string, unknown>
  try {
    return JSON.parse(String(json))
  } catch {
    return {}
  }
}

function callsOfStep(d: Record<string, any>): Call[] {
  if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
    return d.message.content.filter((c: { type?: string }) => c.type === 'tool_use').map((c: { name: string; input: unknown }) => ({ name: c.name, input: parsedOrEmpty(c.input) }))
  }
  if (d.type === 'response_item' && String(d.payload?.type).endsWith('_call')) {
    return [{ name: String(d.payload.name), input: parsedOrEmpty(d.payload.arguments ?? d.payload.input) }]
  }
  if (d.type === 'PLANNER_RESPONSE' && Array.isArray(d.tool_calls)) {
    return d.tool_calls.map((c: { name?: string; args?: unknown }) => ({ name: String(c.name ?? ''), input: parsedOrEmpty(c.args) }))
  }
  return []
}

const asText = (v: unknown) => (Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : '')

function commandsRunBy({ name, input }: Call): string[] {
  if (name === 'REPL') return [...asText(input.code).matchAll(SHELL_IN_A_SCRIPT)].map((m) => m[1]!)
  return [input.command, input.cmd, input.CommandLine].map(asText).filter(Boolean)
}

export function milestoneOfCall(call: Call): Milestone {
  const edits = TOOLS_THAT_EDIT.has(call.name) || (call.name === 'REPL' && SCRIPT_THAT_EDITS.test(asText(call.input.code)))
  const reviewer = (call.name === 'Agent' || call.name === 'Task') && REVIEWER_AGENT.test(asText(call.input.subagent_type))
  const signs = commandsRunBy(call).flatMap(signsOf)
  return furthest([edits ? 'edited' : 'started', reviewer ? 'review' : 'started', ...signs])
}

const stepTime = (d: Record<string, any>) => {
  const at = Date.parse(d.timestamp ?? d.created_at ?? '')
  return Number.isNaN(at) ? null : at / 1000
}

function callsSince(transcript: string | undefined, since: number): Call[] {
  if (!transcript) return []
  let lines: string[]
  try {
    lines = tailLines(transcript)
  } catch {
    return []
  }
  return lines.flatMap((line) => {
    try {
      const step = JSON.parse(line)
      const at = stepTime(step)
      return at === null || at >= since ? callsOfStep(step) : []
    } catch {
      return []
    }
  })
}

export const milestoneOfTranscript = (transcript: string | undefined, since = 0): Milestone => furthest(callsSince(transcript, since).map(milestoneOfCall))

const succeeds = (cmd: string, args: string[], cwd: string) =>
  exec(cmd, args, { cwd, timeout: PROBE_TIMEOUT_MS }).then(
    (r) => r.stdout.trim(),
    () => null,
  )

export async function milestoneOfCheckout(cwd: string | undefined, since = 0): Promise<Milestone> {
  if (!cwd) return 'started'
  const committedSince = await succeeds('git', ['rev-list', '--count', `--since=@${Math.floor(since)}`, 'origin/main..HEAD'], cwd)
  if (!Number(committedSince)) return 'started'
  const pr = await succeeds('gh', ['pr', 'view', '--json', 'createdAt', '--jq', '.createdAt'], cwd)
  return pr && Date.parse(pr) / 1000 >= since ? 'pr' : 'committed'
}

async function overwrite(path: string, live: Live) {
  const fresh = `${path}.${process.pid}`
  await writeFile(fresh, JSON.stringify(live))
  await rename(fresh, path)
}

export async function recordProgress(input: HookInput, held: Held[], boardDir: string, now = Date.now() / 1000): Promise<string[]> {
  const session = input.session_id
  if (!session) return []
  await mkdir(progressDir(boardDir), { recursive: true })
  await mkdir(join(boardDir, STAMP_FOLDER), { recursive: true })
  const stamp = sessionStamp(boardDir, session)
  await writeFile(stamp, '')
  const stampedSoTheHookWaitsItsGap = held.length ? now : now - WRITE_EVERY_SECONDS + LOOKS_AGAIN_AFTER_SECONDS
  await utimes(stamp, stampedSoTheHookWaitsItsGap, stampedSoTheHookWaitsItsGap)
  if (!held.length) return []
  for (const task of held) {
    const sinceClaimed = [milestoneOfTranscript(input.transcript_path, task.claimedAt), await milestoneOfCheckout(input.cwd, task.claimedAt)]
    const onlyForward = furthest([readLive(boardDir, task.id)?.milestone ?? 'started', ...sinceClaimed])
    await overwrite(liveFile(boardDir, task.id), { milestone: onlyForward, at: Math.floor(now) })
  }
  return held.map((h) => h.id)
}

export async function progress(heldBy: (session: string) => Promise<Held[]>, boardDir: string): Promise<number> {
  let input: HookInput
  try {
    input = JSON.parse(await text(process.stdin))
  } catch {
    return 0
  }
  if (!input.session_id) return 0
  await recordProgress(input, await heldBy(input.session_id), boardDir)
  return 0
}
