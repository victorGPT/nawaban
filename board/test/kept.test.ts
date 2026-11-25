import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { KEPT_FRESH_FOR_MS, keptReads, StillReading } from '../src/kept.ts'
import { Refused } from '../src/said.ts'

const nothingLanded = () => {}
const onDisk = async (dir: string) => {
  while (!(await readdir(join(dir, 'kept-reads')).catch(() => [])).some((f) => f.endsWith('.json'))) await new Promise((r) => setTimeout(r, 5))
}

it('after a restart answers from disk, and once the board moves waits for a read made after the move', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-kept-'))
  expect(await keptReads(dir, nothingLanded).read('views', 'board', async () => 'before the restart', { local: true })).toBe('before the restart')
  await onDisk(dir)

  const restarted = keptReads(dir, nothingLanded)
  const reads: ((value: string) => void)[] = []
  const slow = () => new Promise<string>((done) => reads.push(done))
  expect(await restarted.read('views', 'board', slow, { local: true }), 'what the last process read').toBe('before the restart')
  void restarted.moved('views')
  const afterTheMove = restarted.read('views', 'board', slow, { local: true })
  reads.shift()!('read before the move landed')
  await new Promise((r) => setTimeout(r, 5))
  reads.shift()!('read after the move')
  expect(await afterTheMove).toBe('read after the move')
})

it('never waits on a read that is not local, and keeps a refusal as the answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-kept-'))
  const landed: string[] = []
  const kept = keptReads(dir, (group, changed) => void (changed && landed.push(group)))
  await expect(kept.read('github:r', 'task #9', () => new Promise<string>(() => {}), { local: false })).rejects.toBeInstanceOf(StillReading)
  await expect(kept.read('github:r', 'task #8', () => Promise.reject(new Refused('任务不存在:#8')), { local: false })).rejects.toBeInstanceOf(StillReading)
  while (!landed.length) await new Promise((r) => setTimeout(r, 5))
  await expect(kept.read('github:r', 'task #8', () => Promise.reject(new Refused('again')), { local: false })).rejects.toThrow('任务不存在:#8')
})

it('after a restart, a move made before the first read still makes that read wait for one made after it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-kept-'))
  await keptReads(dir, nothingLanded).read('views', 'projects', async () => 'before the restart', { local: true })
  await onDisk(dir)
  const restarted = keptReads(dir, nothingLanded)
  void restarted.moved('views')
  expect(await restarted.read('views', 'projects', async () => 'after the move', { local: true })).toBe('after the move')
})

it('answers a background read that failed as that failure and says so, and reads again once it is old', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-kept-'))
  let clock = 0
  const landed: boolean[] = []
  const kept = keptReads(dir, (_, changed) => void landed.push(changed), () => clock)
  let attempts = 0
  const flaky = async () => (++attempts === 1 ? Promise.reject(new Error('transient')) : 'board')
  await expect(kept.read('github:r', 'board', flaky, { local: false })).rejects.toBeInstanceOf(StillReading)
  while (!landed.length) await new Promise((r) => setTimeout(r, 5))
  await expect(kept.read('github:r', 'board', flaky, { local: false })).rejects.toThrow('transient')
  clock += KEPT_FRESH_FOR_MS + 1
  await expect(kept.read('github:r', 'board', flaky, { local: false })).rejects.toThrow('transient')
  while (landed.length < 2) await new Promise((r) => setTimeout(r, 5))
  expect(await kept.read('github:r', 'board', flaky, { local: false })).toBe('board')
})

it('says a read landed even when the read again it was asked for meanwhile failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-kept-'))
  const landed: boolean[] = []
  const kept = keptReads(dir, (_, changed) => void landed.push(changed))
  let finish!: (value: string) => void
  let attempts = 0
  const again = () => (++attempts === 1 ? new Promise<string>((done) => (finish = done)) : Promise.reject(new Error('retry failed')))
  for (let n = 0; n < 2; n++) await expect(kept.read('github:r', 'board', again, { local: false })).rejects.toBeInstanceOf(StillReading)
  finish('new board')
  while (!landed.length) await new Promise((r) => setTimeout(r, 5))
  expect(landed).toContain(true)
  expect(await kept.read('github:r', 'board', again, { local: false })).toBe('new board')
})
