import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'smol-toml'

export type SandboxOutcome =
  | { kind: 'already-open' }
  | { kind: 'appended'; text: string }
  | { kind: 'left-to-the-owner'; lines: string }

export function leaseDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'board')
}

function sandboxTable(lease: string): string {
  return `[sandbox_workspace_write]\nnetwork_access = true\nwritable_roots = [${JSON.stringify(lease)}]\n`
}

export function openSandboxToTheBoard(config: string, lease: string): SandboxOutcome {
  const sandbox = parse(config).sandbox_workspace_write as { network_access?: unknown; writable_roots?: unknown } | undefined
  if (sandbox === undefined) return { kind: 'appended', text: config.trim() ? `${config.trimEnd()}\n\n${sandboxTable(lease)}` : sandboxTable(lease) }
  const roots = Array.isArray(sandbox.writable_roots) ? sandbox.writable_roots : []
  if (sandbox.network_access === true && roots.includes(lease)) return { kind: 'already-open' }
  return { kind: 'left-to-the-owner', lines: `network_access = true\nwritable_roots = ${JSON.stringify([...roots, lease].filter((r, i, all) => all.indexOf(r) === i))}` }
}

function readElseEmptyWhenMissing(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

function main(): number {
  const config = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
  const lease = leaseDir()
  mkdirSync(lease, { recursive: true })
  const outcome = openSandboxToTheBoard(readElseEmptyWhenMissing(config), lease)
  if (outcome.kind === 'appended') {
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, outcome.text)
    console.log(`已在 ${config} 打开 Codex 沙箱：可连本机看板、可写 ${lease}`)
  } else if (outcome.kind === 'already-open') {
    console.log(`${config} 已允许 Codex 连本机看板、写 ${lease}`)
  } else {
    console.log(`${config} 已有 [sandbox_workspace_write]，没改它。请在那张表里写成：\n${outcome.lines}`)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
