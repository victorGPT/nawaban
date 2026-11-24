import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'

export type Step = { subject: string; status: string }
export type Live = { steps: Step[] | null; summary: string | null; at: number }
type HookInput = { session_id?: string; transcript_path?: string; last_assistant_message?: string }
type Held = { id: string }

const PROGRESS_FOLDER = 'progress'
const TRANSCRIPT_TAIL_BYTES = 1 << 20
const SUMMARY_CHARS = 80
const WRITE_EVERY_SECONDS = 5 * 60
const UNHELD_SESSION_LOOKS_AGAIN_AFTER_SECONDS = 60
const SENTENCE_END = /(?<=[。！？!?])|\n+/

export const progressDir = (boardDir: string) => join(boardDir, PROGRESS_FOLDER)
export const liveFile = (boardDir: string, taskId: string) => join(progressDir(boardDir), `${taskId}.json`)
const sessionStamp = (boardDir: string, session: string) => join(progressDir(boardDir), `.session-${session}`)

export function readLive(boardDir: string, taskId: string): Live | null {
  try {
    return JSON.parse(readFileSync(liveFile(boardDir, taskId), 'utf8')) as Live
  } catch {
    return null
  }
}

export const forgetLive = (boardDir: string, taskId: string) => rm(liveFile(boardDir, taskId), { force: true })

const claudeTasksDir = (session: string) => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'tasks', session)

export function stepsOf(dir: string): Step[] | null {
  if (!existsSync(dir)) return null
  const steps = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const t = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        return typeof t.subject === 'string' ? [{ n: Number(t.id), subject: t.subject, status: String(t.status) }] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => a.n - b.n)
  return steps.length ? steps.map(({ subject, status }) => ({ subject, status })) : null
}

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

type Content = { type?: string; text?: string; input?: { description?: unknown } }

function wordsOfStep(d: Record<string, any>): string | null {
  if (d.type === 'PLANNER_RESPONSE' && typeof d.content === 'string') return d.content
  const codex = d.type === 'response_item' && d.payload?.type === 'message' && d.payload.role === 'assistant' ? d.payload.content : null
  const claude = d.type === 'assistant' ? d.message?.content : null
  const parts: Content[] = Array.isArray(codex ?? claude) ? (codex ?? claude) : []
  const said = parts.filter((c) => (c.type === 'text' || c.type === 'output_text') && c.text?.trim()).map((c) => c.text!)
  if (said.length) return said.join('\n')
  const described = parts.findLast((c) => c.type === 'tool_use' && typeof c.input?.description === 'string')
  return described ? String(described.input!.description) : null
}

export function lastWords(transcript: string | undefined): string | null {
  if (!transcript) return null
  let lines: string[]
  try {
    lines = tailLines(transcript)
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const words = wordsOfStep(JSON.parse(lines[i]!))
      if (words) return words
    } catch {}
  }
  return null
}

export function lastSentence(words: string | null | undefined): string | null {
  const plain = (words ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\*\*|`|^#+\s*/gm, '')
  const sentences = plain.split(SENTENCE_END).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const last = sentences.at(-1)
  if (!last) return null
  const chars = [...last]
  return chars.length <= SUMMARY_CHARS ? last : chars.slice(0, SUMMARY_CHARS).join('') + '…'
}

const sameProgress = (a: Live | null, b: Omit<Live, 'at'>) => !!a && JSON.stringify([a.steps, a.summary]) === JSON.stringify([b.steps, b.summary])

async function overwrite(path: string, live: Live) {
  const fresh = `${path}.${process.pid}`
  await writeFile(fresh, JSON.stringify(live))
  await rename(fresh, path)
}

export async function recordProgress(input: HookInput, held: Held[], boardDir: string, now = Date.now() / 1000): Promise<string[]> {
  const session = input.session_id
  if (!session) return []
  await mkdir(progressDir(boardDir), { recursive: true })
  const stamp = sessionStamp(boardDir, session)
  await writeFile(stamp, '')
  const stampedSoTheHookWaitsItsGap = held.length ? now : now - WRITE_EVERY_SECONDS + UNHELD_SESSION_LOOKS_AGAIN_AFTER_SECONDS
  await utimes(stamp, stampedSoTheHookWaitsItsGap, stampedSoTheHookWaitsItsGap)
  const next = { steps: stepsOf(claudeTasksDir(session)), summary: lastSentence(input.last_assistant_message ?? lastWords(input.transcript_path)) }
  const written = []
  for (const { id } of held) {
    if (!next.steps && !next.summary) continue
    if (sameProgress(readLive(boardDir, id), next)) continue
    await overwrite(liveFile(boardDir, id), { ...next, at: Math.floor(now) })
    written.push(id)
  }
  return written
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
