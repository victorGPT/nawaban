import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const CONFIG_FILE = 'github-sync.json'
export const STATE_FOLDER = 'github-sync'
export const POLL_EVERY_MS = 60_000
const STALLED_AFTER_MS = 3 * POLL_EVERY_MS

export type SyncConfig = { repos: Record<string, string>; reader: string; push?: string[] }
type SyncStatus = { okAt?: string; failedAt?: string; error?: string }

export async function githubSyncConfig(dir: string): Promise<SyncConfig | null> {
  let text
  try {
    text = await readFile(join(dir, CONFIG_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const config = JSON.parse(text) as Partial<SyncConfig>
  const reposValid = typeof config.repos === 'object' && config.repos !== null && Object.values(config.repos).every((c) => typeof c === 'string')
  const pushValid = config.push === undefined || (reposValid && Array.isArray(config.push) && config.push.every((r) => typeof r === 'string' && r in config.repos!))
  if (!reposValid || typeof config.reader !== 'string' || !pushValid) throw new Error(`${join(dir, CONFIG_FILE)} 要写成 { "repos": { "<owner>/<repo>": "<channel>" }, "reader": "<gh 账号>", "push": ["<repos 里要推的 owner/repo>"] }`)
  return config as SyncConfig
}

const statusFile = (dir: string, repo: string) => join(dir, STATE_FOLDER, `${encodeURIComponent(repo)}.status.json`)

async function statusOf(dir: string, repo: string): Promise<SyncStatus | null> {
  try {
    return JSON.parse(await readFile(statusFile(dir, repo), 'utf8')) as SyncStatus
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function recordRound(dir: string, repo: string, error?: Error, now = new Date()) {
  const had = (await statusOf(dir, repo)) ?? {}
  const status: SyncStatus = error ? { okAt: had.okAt, failedAt: now.toISOString(), error: error.message } : { okAt: now.toISOString() }
  await mkdir(join(dir, STATE_FOLDER), { recursive: true })
  const tmp = `${statusFile(dir, repo)}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(status))
  await rename(tmp, statusFile(dir, repo))
}

const clockOf = (iso: string) => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

const pushFile = (dir: string, repo: string) => join(dir, STATE_FOLDER, `${encodeURIComponent(repo)}.push.json`)
type PushStatus = { unpushed: number; error?: string }

export async function recordPush(dir: string, repo: string, status: PushStatus) {
  await mkdir(join(dir, STATE_FOLDER), { recursive: true })
  const tmp = `${pushFile(dir, repo)}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(status))
  await rename(tmp, pushFile(dir, repo))
}

async function pushStatusOf(dir: string, repo: string): Promise<PushStatus | null> {
  try {
    return JSON.parse(await readFile(pushFile(dir, repo), 'utf8')) as PushStatus
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function syncStalledNote(dir: string, channel: string, now = Date.now()): Promise<string | null> {
  const repos = Object.entries((await githubSyncConfig(dir))?.repos ?? {}).filter(([, c]) => c === channel).map(([repo]) => repo)
  for (const repo of repos) {
    const status = await statusOf(dir, repo)
    if (!status) return `GitHub 同步还没跑过一轮（${repo}；nawaban serve 改了 github-sync.json 后重启了吗）`
    const stalled = !status.okAt || now - Date.parse(status.okAt) > STALLED_AFTER_MS
    if (stalled) return `GitHub 同步停在 ${status.okAt ? clockOf(status.okAt) : '还没成功过'}（${status.error ?? '没有新的一轮'}）`
    const push = await pushStatusOf(dir, repo)
    if (push?.error) return `${push.unpushed < 0 ? '推送没跑起来' : `有 ${push.unpushed} 条还没推到 GitHub`}（${push.error}）`
  }
  return null
}

