import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { board, Middleware } from '@vercel/board'
import { findBlocks } from '@vercel/board/schemas'
import { parse } from 'smol-toml'

type Team = ReturnType<typeof board>
type Impact = { objective: string; krs: { name: string; dir: string; before?: string; after?: string }[] }

export const OKR_FILE = 'docs/agents/okr.toml'
export const IMPACT_FORMAT = '<KR 名>=↑|↓|=[ 前→后 实测|预计]'
const NUMBER = /^-?\d+(?:\.\d+)?%?$/
const run = promisify(execFile)

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function repos(dir: string): Promise<Record<string, string>> {
  try {
    const map = JSON.parse(await readFile(join(dir, 'repos.json'), 'utf8'))
    return Object.fromEntries(Object.entries(map).filter(([, path]) => typeof path === 'string').map(([k, path]) => [k, resolve((path as string).replace(/^~(?=\/|$)/, homedir()))]))
  } catch (error) {
    if (missing(error)) return {}
    throw new Error(`${join(dir, 'repos.json')} isn't a JSON object of project to repository path: ${(error as Error).message}`)
  }
}

async function objectives(repo: string): Promise<Map<string, string[]> | null> {
  let text
  try {
    text = await readFile(join(repo, OKR_FILE), 'utf8')
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
  const doc = parse(text) as { objective?: { name?: unknown; kr?: { name?: unknown }[] }[] }
  return new Map((doc.objective ?? []).map((o) => [String(o.name), (o.kr ?? []).map((kr) => String(kr.name))]))
}

export async function projectOf(dir: string, top: string) {
  const real = (path: string) => realpath(path).catch(() => path)
  const here = await real(top)
  let project
  for (const [name, path] of Object.entries(await repos(dir))) if ((await real(path)) === here) project = name
  return project
}

export async function okrOf(dir: string, channel: string) {
  const repo = (await repos(dir))[channel]
  return repo ? objectives(repo) : null
}

function refusal(impact: Impact, okr: Map<string, string[]> | null, channel: string, dir: string): string | null {
  const o = impact.objective
  if (o === '无') return impact.krs.length ? '--o 无 不带 --kr' : null
  if (!okr) return `项目 ${channel} 没有 ${OKR_FILE}(仓库路径登记在 ${join(dir, 'repos.json')}),只能 --o 无`
  const names = okr.get(o)
  if (!names) return `${OKR_FILE} 里没有这个 O:${o}(有:${[...okr.keys()].join('、')})`
  for (const kr of impact.krs) {
    if (!names.includes(kr.name)) return `${o} 下没有这个 KR:${kr.name}(有:${names.join('、')})`
    if (kr.dir !== '=' && !(NUMBER.test(kr.before!) && NUMBER.test(kr.after!))) return `↑↓ 的前后值要是数字:${kr.name}=${kr.dir} ${kr.before}→${kr.after}`
  }
  return null
}

export function impactNames(dir: string): Middleware {
  return async ({ write, respond, next }) => {
    const impacts = findBlocks(write.text).filter((b) => b.name === 'nawaban-impact' && b.data)
    if (!impacts.length) return next()
    let why
    try {
      const okr = await okrOf(dir, write.channel)
      why = impacts.map((b) => refusal(b.data as Impact, okr, write.channel, dir)).find(Boolean)
    } catch (error) {
      why = `核不了 KR 影响声明:${(error as Error).message}`
    }
    if (why) return respond(why)
    return next()
  }
}

export const howToDeclare = (ref: string) => `  nawaban event ${ref} --kind impact --o "<O 名>" --kr "${IMPACT_FORMAT}"(--kr 可重复;纯基础设施写 --o 无)`

async function declared(team: Team, id: string) {
  const { replies } = await team.thread(id)
  return replies.some((r) => r.blocks.some((b) => b.schema === 'nawaban-impact'))
}

export async function undeclared(team: Team, id: string, dir: string): Promise<string | null> {
  const { message } = await team.thread(id, { limit: 1 })
  if (!(await okrOf(dir, message.channel)) || (await declared(team, id))) return null
  return `${message.labels.key ?? '#' + id} 没有 KR 影响声明,不能 close --done。先补:\n${howToDeclare(message.labels.key ?? id)}`
}

const MERGE = /(?:^|[;&|(\n])\s*(?:\w+=(?:\$\([^)]*\)|\S*)\s+)*(?:gh(?:\s+(?:-R|--repo)(?:\s+|=)\S+)*\s+pr\s+merge|(?:(?:ba|z)?sh\s+)?(?:\S*\/)?scripts\/merge\.sh)(?=[\s;&|)]|$)/g

const CLOSE =
  /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:(?:npx|bunx|pnpm|yarn|exec|dlx|node|vercel)(?:\s+-\S+)*\s+)*(?:\S*\/)?(?:vb|board|nawaban|cli\.ts|@vercel\/board(?:@\S*)?)\s+(?:[^;&|\n)]*\s)?tasks\s+(?:complete|fail|cancel)(?=[\s;&|)]|$)/
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'])

const blank = (cmd: string) => cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) => "'" + 'x'.repeat(q.length - 2) + "'")

export function closeGate(cmd: string): string | null {
  return CLOSE.test(blank(cmd))
    ? 'agent 不直接调 tasks complete|fail|cancel:关单用 nawaban close <key> --done|--cancelled(有 okr.toml 的项目,--done 要先有 KR 影响声明)'
    : null
}

const words = (s: string) => s.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g)?.map((w) => w.replace(/^(['"])(.*)\1$/s, '$2')) ?? []

export async function mergeGate(cmd: string, cwd: string, team: Team, dir: string): Promise<string | null> {
  const flat = blank(cmd)
  const merges = [...flat.matchAll(MERGE)]
  if (!merges.length) return null
  const common = (await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).catch(() => null))?.stdout.trim()
  if (!common) return null
  const top = resolve(common, '..')
  const project = await projectOf(dir, top)
  if (!project || !(await objectives(top))) return null
  for (const m of merges) {
    const end = m.index + m[0].length
    const stop = flat.slice(end).search(/[;&|\n)]|$/)
    const args = words(cmd.slice(end, end + stop))
    let sel: string | undefined

    let repo = /(?:-R|--repo)(?:\s+|=)(\S+)/.exec(cmd.slice(m.index, end))?.[1]
    for (let i = 0; i < args.length; i++) {
      if (GH_VALUE_FLAGS.has(args[i]!)) {
        if (args[i] === '-R' || args[i] === '--repo') repo = args[i + 1]
        i++
      } else if (!args[i]!.startsWith('-') && sel === undefined) sel = args[i]
    }
    if (sel === undefined && m[0].includes('merge.sh')) return 'scripts/merge.sh 没写 PR 号,核不了 KR 影响声明'
    let pr: { number: number; title: string; body: string; headRefName: string }
    try {
      const view = ['pr', 'view', ...(sel ? [sel] : []), ...(repo ? ['--repo', repo] : []), '--json', 'number,title,body,headRefName']
      pr = JSON.parse((await run('gh', view, { cwd })).stdout)
    } catch (error) {
      return `查不到这个 PR,核不了 KR 影响声明:${(error as Error).message.trim()}`
    }
    const text = [pr.title, pr.body, pr.headRefName].join(' ')
    const named = (await liveTasks(team, project)).filter((t) => {
      const key = t.labels.key
      return key && new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text)
    })
    if (!named.length) return `PR #${pr.number} 没写到项目 ${project} 的任何一张票(标题、正文、分支名里写票号),核不了 KR 影响声明`
    const missed = []
    for (const t of named) if (!(await declared(team, t.id))) missed.push(t.labels.key!)
    if (missed.length) return `PR #${pr.number} 的关联票没有 KR 影响声明(${missed.join('、')}),先补再合并:\n${missed.map(howToDeclare).join('\n')}`
  }
  return null
}

async function liveTasks(team: Team, channel: string) {
  const out = []
  for (let after: string | undefined; ; ) {
    const page = await team.tasks.list({ channel, state: 'all', after, limit: 50 })
    out.push(...page.tasks.map((t) => t.message).filter((m) => m.task?.state !== 'canceled'))
    if (page.tasks.length < 50) return out
    after = page.cursor
  }
}
