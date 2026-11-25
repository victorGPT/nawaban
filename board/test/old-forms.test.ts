import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const SCRIPT = new URL('../scripts/old-forms.mjs', import.meta.url).pathname

const run = (root: string) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile('node', [SCRIPT, root], (error, out) => resolve({ code: error ? Number(error.code) : 0, out })),
  )

it('lists the board CLI calls still written the old way, and passes the new forms and the old CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nawaban-old-forms-'))
  await mkdir(join(root, 'hooks'))
  await writeFile(
    join(root, 'hooks', 'stop.sh'),
    [
      'node "$hooks/../board/src/cli.ts" inbox --project "$p"',
      'node "$hooks/../board/src/cli.ts" status --line --project "$p"',
      'nawaban event X --kind note --body done',
      'nawaban event X note done',
      'nawaban create X --title t --body-file f.md',
      "python3 cli.py --db /b event '#3' --kind note --body x",
    ].join('\n'),
  )
  const r = await run(root)
  expect(r.code).toBe(1)
  expect(r.out).toBe(
    'hooks/stop.sh:1: node "$hooks/../board/src/cli.ts" inbox --project "$p"\nhooks/stop.sh:3: nawaban event X --kind note --body done\n旧写法调用点 2 处\n',
  )
  expect(await run(await mkdtemp(join(tmpdir(), 'nawaban-old-forms-empty-')))).toEqual({ code: 0, out: '旧写法调用点 0 处\n' })
})
