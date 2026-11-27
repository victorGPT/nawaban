import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { backup } from '../src/backup.ts'

let dir: string
afterEach(() => rm(dir, { recursive: true, force: true }))

test('backup copies the board file, rows in the WAL included, into backups/ under a timestamped name', async () => {
  dir = await mkdtemp(join(tmpdir(), 'nawaban-backup-'))
  const live = new DatabaseSync(join(dir, 'local.db'))
  live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES ('kept')")
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  expect(await backup(dir, new Date('2026-11-27T03:04:05Z'))).toBe(0)
  live.close()
  expect(await readdir(join(dir, 'backups'))).toEqual(['local-20261127-030405.db'])
  const copy = new DatabaseSync(join(dir, 'backups', 'local-20261127-030405.db'), { readOnly: true })
  expect(copy.prepare('SELECT x FROM t').all()).toEqual([{ x: 'kept' }])
  copy.close()
})
