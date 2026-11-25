import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { keptReads, StillReading } from '../src/kept.ts'
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
