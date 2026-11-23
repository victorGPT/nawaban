import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parse } from 'smol-toml'
import { openSandboxToTheBoard } from '../src/codex.ts'

const exec = promisify(execFile)
const SCRIPT = join(import.meta.dirname, '../src/codex.ts')
const LEASE = '/home/u/.config/board'

it('appends the sandbox table to a config without one, keeping what was there', () => {
  const config = '# mine\nmodel = "gpt"\n[plugins."nawaban@nawaban"]\nenabled = true'
  const outcome = openSandboxToTheBoard(config, LEASE)
  expect(outcome.kind).toBe('appended')
  if (outcome.kind !== 'appended') return
  expect(outcome.text.startsWith(config)).toBe(true)
  const parsed = parse(outcome.text) as Record<string, any>
  expect(parsed.sandbox_workspace_write).toEqual({ network_access: true, writable_roots: [LEASE] })
  expect(parsed.plugins['nawaban@nawaban'].enabled).toBe(true)
  expect(openSandboxToTheBoard(outcome.text, LEASE).kind).toBe('already-open')
})

it('leaves an existing sandbox table to the owner and says what it should read', () => {
  const outcome = openSandboxToTheBoard('[sandbox_workspace_write]\nwritable_roots = ["/data"]\n', LEASE)
  expect(outcome).toEqual({ kind: 'left-to-the-owner', lines: `network_access = true\nwritable_roots = ["/data","${LEASE}"]` })
})

it('writes a fresh CODEX_HOME config and the lease dir, and a second run changes nothing', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'codex-'))
  const env = { ...process.env, CODEX_HOME: join(tmp, 'codex'), XDG_CONFIG_HOME: join(tmp, 'xdg') }
  await exec(process.execPath, [SCRIPT], { env })
  const config = join(tmp, 'codex', 'config.toml')
  const first = await readFile(config, 'utf8')
  expect((parse(first) as any).sandbox_workspace_write.writable_roots).toEqual([join(tmp, 'xdg', 'board')])
  expect(existsSync(join(tmp, 'xdg', 'board'))).toBe(true)
  await exec(process.execPath, [SCRIPT], { env })
  expect(await readFile(config, 'utf8')).toBe(first)
})

it('stops without writing when the config exists but cannot be read', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'codex-'))
  await mkdir(join(tmp, 'codex', 'config.toml'), { recursive: true })
  const env = { ...process.env, CODEX_HOME: join(tmp, 'codex'), XDG_CONFIG_HOME: join(tmp, 'xdg') }
  await expect(exec(process.execPath, [SCRIPT], { env })).rejects.toThrow(/EISDIR/)
})
