import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Refused } from './said.ts'

export const KEPT_FRESH_FOR_MS = 30_000
const STILL_WANTED_FOR_MS = 10 * 60_000
const KEPT_DIR = 'kept-reads'
const NAME_HASH_LENGTH = 32
const READ_BEFORE_THIS_PROCESS = -1

export class StillReading extends Error {}

type Read = { ok: boolean; value: unknown; at: number; generation: number }
type Entry = { group: string; again: () => Promise<unknown>; read?: Read; wanted: number; running?: Promise<boolean>; rerun?: boolean }
export type Landed = (group: string, changed: boolean) => void

const sameRead = (a: Read | undefined, b: Read) => !!a && a.ok === b.ok && JSON.stringify(a.value) === JSON.stringify(b.value)

export function keptReads(dir: string, landed: Landed, now = () => Date.now()) {
  const entries = new Map<string, Entry>()
  const generations = new Map<string, number>()
  const generationOf = (group: string) => generations.get(group) ?? 0
  const fileOf = (key: string) => join(dir, KEPT_DIR, createHash('sha256').update(key).digest('hex').slice(0, NAME_HASH_LENGTH) + '.json')
  const movedSinceRead = (e: Entry) => e.read!.generation !== READ_BEFORE_THIS_PROCESS && e.read!.generation !== generationOf(e.group)
  const stale = (e: Entry) => e.read!.generation !== generationOf(e.group) || now() - e.read!.at > KEPT_FRESH_FOR_MS

  async function keepOnDisk(key: string, read: Read) {
    const path = fileOf(key)
    const writtenWholeBeforeAnyReaderSeesIt = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`
    try {
      await mkdir(join(dir, KEPT_DIR), { recursive: true, mode: 0o700 })
      await writeFile(writtenWholeBeforeAnyReaderSeesIt, JSON.stringify({ key, ok: read.ok, value: read.value, at: read.at }), { mode: 0o600 })
      await rename(writtenWholeBeforeAnyReaderSeesIt, path)
    } catch (error) {
      console.error(`kept read of ${key} not written to disk:`, error)
    }
  }

  async function keptOnDiskAsStale(key: string): Promise<Read | undefined> {
    try {
      const kept = JSON.parse(await readFile(fileOf(key), 'utf8')) as { key: string; ok: boolean; value: unknown; at: number }
      return kept.key === key ? { ok: kept.ok, value: kept.value, at: kept.at, generation: READ_BEFORE_THIS_PROCESS } : undefined
    } catch {
      return undefined
    }
  }

  function refresh(key: string, e: Entry): Promise<boolean> {
    if (e.running) {
      e.rerun = true
      return e.running
    }
    e.running = (async () => {
      let changed = false
      do {
        e.rerun = false
        const generation = generationOf(e.group)
        let read: Read
        try {
          read = { ok: true, value: await e.again(), at: now(), generation }
        } catch (error) {
          if (!(error instanceof Refused)) {
            if (!e.read) throw error
            console.error(`reading ${key} again failed, the last read stays:`, error)
            return changed
          }
          read = { ok: false, value: error.message, at: now(), generation }
        }
        const differs = !sameRead(e.read, read)
        e.read = read
        if (differs) {
          changed = true
          void keepOnDisk(key, read)
        }
      } while (e.rerun)
      return changed
    })().finally(() => (e.running = undefined))
    return e.running
  }

  const inTheBackground = (key: string, e: Entry) =>
    refresh(key, e).then(
      (changed) => landed(e.group, changed),
      (error) => console.error(`reading ${key} failed:`, error),
    )

  const answered = (read: Read) => {
    if (!read.ok) throw new Refused(String(read.value))
    return read.value
  }

  return {
    async read<T>(group: string, key: string, again: () => Promise<T>, { local }: { local: boolean }): Promise<T> {
      const e = entries.get(key) ?? { group, again, wanted: 0 }
      entries.set(key, e)
      e.again = again
      e.wanted = now()
      e.read ??= await keptOnDiskAsStale(key)
      const localWorkCanAnswerNow = local && (!e.read || movedSinceRead(e))
      if (localWorkCanAnswerNow) await refresh(key, e)
      else if (!e.read) {
        void inTheBackground(key, e)
        throw new StillReading(key)
      } else if (stale(e)) void inTheBackground(key, e)
      return answered(e.read!) as T
    },
    async moved(group: string) {
      generations.set(group, generationOf(group) + 1)
      const wanted = [...entries].filter(([, e]) => e.group === group && now() - e.wanted < STILL_WANTED_FOR_MS)
      const changed = await Promise.all(wanted.map(([key, e]) => refresh(key, e).catch((error) => (console.error(`reading ${key} failed:`, error), false))))
      return changed.some(Boolean)
    },
  }
}
