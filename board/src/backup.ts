import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const stampOf = (at: Date) => at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

export async function backup(dir: string, at = new Date()): Promise<number> {
  const copy = join(dir, 'backups', `local-${stampOf(at)}.db`)
  await mkdir(join(dir, 'backups'), { recursive: true })
  const db = new DatabaseSync(join(dir, 'local.db'), { readOnly: true })
  try {
    db.prepare('VACUUM INTO ?').run(copy)
  } finally {
    db.close()
  }
  process.stdout.write(`✓ 备份到 ${copy}\n`)
  return 0
}
