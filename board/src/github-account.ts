import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { reposReadOnEveryUseSoEditsNeedNoRestart, words } from './impact.ts'
import { Refused } from './said.ts'

export const ACCOUNT_DECLARED_IN = 'docs/agents/issue-tracker.md'
const FENCED_OR_COMMENTED_EXAMPLE_UNCLOSED_RUNS_TO_THE_END = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1|$(?![\s\S]))|<!--[\s\S]*?(?:-->|$(?![\s\S]))/gm
const DECLARATION = /^github-account:[ \t]*([A-Za-z0-9-]+)[ \t]*\r?$/m
const RUNS_A_STRING_AS_A_COMMAND = /\b(?:(?:ba|z|da)?sh\s+-\w*c|eval)\b/
const GRAPHQL_WRITE = /\bmutation\b|--input\b/
const SEGMENT_END = /[;&|\n)`]|$/
const HEREDOC_BODY = /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\s|$)/g
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g
const TOKEN_SET_OUTSIDE_A_PROVEN_PREFIX = /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)\b|\bgh\s+auth\s+(?:switch|login)\b/
const READ_ONLY_GROUPS = new Set(['auth', 'help', 'version', '--version', '--help', 'status', 'browse', 'search', 'completion', 'config', 'alias'])
const READ_ONLY_VERBS = new Set(['view', 'list', 'status', 'checks', 'diff', 'watch', 'download', 'clone', 'verify'])
const API_SENDS_A_BODY = /^(?:-f|-F|--field(?:=|$)|--raw-field(?:=|$)|--input(?:=|$))/
const API_METHOD = /^(?:-X=?|--method(?:=|$))(.*)$/
const REPO_FLAG = /^(?:-R|--repo)(?:=(.*))?$/
const GITHUB_REPO_IN_REMOTE = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/
const run = promisify(execFile)

const provenPrefix = (account: string) => `GH_TOKEN=$(gh auth token --user ${account})`
const stdoutElseNull = async (cmd: string, args: string[]) => (await run(cmd, args).catch(() => null))?.stdout.trim() || null

async function checkoutsOf(dir: string): Promise<string[]> {
  const top = await stdoutElseNull('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
  const common = await stdoutElseNull('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  return [...new Set([top ?? dir, ...(common ? [resolve(common, '..')] : [])])]
}

export async function githubAccountOf(dir: string): Promise<string> {
  const checkouts = await checkoutsOf(dir)
  for (const checkout of checkouts) {
    const account = DECLARATION.exec((await readFile(join(checkout, ACCOUNT_DECLARED_IN), 'utf8').catch(() => '')).replace(FENCED_OR_COMMENTED_EXAMPLE_UNCLOSED_RUNS_TO_THE_END, ''))?.[1]
    if (account) return account
  }
  throw new Refused(`${checkouts[0]} 没声明用哪个 GitHub 账号写：在 ${ACCOUNT_DECLARED_IN} 加一行 github-account: <账号>`)
}

export async function githubTokenOf(dir: string): Promise<string> {
  const account = await githubAccountOf(dir)
  const token = await stdoutElseNull('gh', ['auth', 'token', '--user', account])
  if (!token) throw new Refused(`本机 gh 没登录 ${dir} 声明的账号 ${account}：先跑 gh auth login，登录 ${account}`)
  return token
}

export const ghEnvOf = async (dir: string) => ({ ...process.env, GH_TOKEN: await githubTokenOf(dir) })

function withoutRepoFlag(args: string[]): string[] {
  const kept = []
  for (let i = 0; i < args.length; i++) {
    const m = REPO_FLAG.exec(args[i]!)
    if (!m) kept.push(args[i]!)
    else if (m[1] === undefined) i++
  }
  return kept
}

function writesToGithub(args: string[], segment: string): boolean {
  const [group, verb] = withoutRepoFlag(args)
  if (group === undefined || READ_ONLY_GROUPS.has(group)) return false
  if (group !== 'api') return !READ_ONLY_VERBS.has(verb ?? '')
  if (args.some((a) => a === 'graphql')) return GRAPHQL_WRITE.test(segment)
  const at = args.findIndex((a) => API_METHOD.test(a))
  const method = at < 0 ? (args.some((a) => API_SENDS_A_BODY.test(a)) ? 'POST' : 'GET') : API_METHOD.exec(args[at]!)![1] || args[at + 1] || ''
  return method.toUpperCase() !== 'GET'
}

function repoFlagOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const m = REPO_FLAG.exec(args[i]!)
    if (m) return m[1] ?? args[i + 1]
  }
  return undefined
}

async function checkoutOfGithubRepo(repo: string, boardDir: string): Promise<string | null> {
  const wanted = repo.replace(/^https?:\/\/github\.com\//, '').toLowerCase()
  for (const path of Object.values(await reposReadOnEveryUseSoEditsNeedNoRestart(boardDir))) {
    const remote = await stdoutElseNull('git', ['-C', path, 'remote', 'get-url', 'origin'])
    if (remote && GITHUB_REPO_IN_REMOTE.exec(remote)?.[1]?.toLowerCase() === wanted) return path
  }
  return null
}

const blank = (s: string) => s.replace(/[^\n]/g, 'x')

const keepingSubstitutions = (s: string) => s.split(/(\$\([^)]*\)|`[^`]*`)/).map((part, i) => (i % 2 ? part : blank(part))).join('')

const textBlankedKeepingWhatTheShellRuns = (cmd: string) =>
  RUNS_A_STRING_AS_A_COMMAND.test(cmd)
    ? cmd.replace(/['"]/g, '\n')
    : cmd
    .replace(HEREDOC_BODY, (body, quote: string) => (quote ? blank(body) : keepingSubstitutions(body)))
    .replace(QUOTED, (q) => q[0] + (q[0] === "'" ? blank(q.slice(1, -1)) : keepingSubstitutions(q.slice(1, -1))) + q.at(-1))

const SEGMENT_START = /[;&|\n`]/
const GH_ANYWHERE = /(?<![\w./-])gh(?=[ \t])/g
const CHANGES_DIRECTORY = /(?<![\w./-])(?:cd|pushd)(?:[ \t]+([^\s;&|)]+))?/g
const PROVEN_ASSIGNMENT = (account: string) => new RegExp(`(?<![\\w])GH_TOKEN="?\\$\\(gh auth token --user ${account}\\)"?(?=\\s)`)
const TOKEN_ASSIGNMENT = /\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)=/g

function directoryTheCommandIsInAt(cmd: string, blanked: string, at: number, cwd: string): string | null {
  const last = [...blanked.slice(0, at).matchAll(CHANGES_DIRECTORY)].at(-1)
  if (!last) return cwd
  const target = last[1] === undefined ? '~' : cmd.slice(last.index + last[0].length - last[1].length, last.index + last[0].length).replace(/^(['"])(.*)\1$/, '$2')
  if (/[$`*]/.test(target) || target === '-') return null
  return resolve(cwd, target.replace(/^~(?=\/|$)/, homedir()))
}

export async function whyThisGhWriteMustNotRun(cmd: string, cwd: string, boardDir: string): Promise<string | null> {
  const blanked = textBlankedKeepingWhatTheShellRuns(cmd)
  for (const m of blanked.matchAll(GH_ANYWHERE)) {
    const end = m.index + m[0].length
    const segment = cmd.slice(end, end + blanked.slice(end).search(SEGMENT_END))
    const args = words(segment)
    if (!writesToGithub(args, segment)) continue
    const target = repoFlagOf(args)
    const here = directoryTheCommandIsInAt(cmd, blanked, m.index, cwd)
    if (!here) return 'gh 写操作前 cd 到的目录核不了（带变量或 cd -），不知道是哪个仓库：cd 写成字面路径，或在那个仓库里另起一条命令'
    const checkout = target ? await checkoutOfGithubRepo(target, boardDir) : here
    if (!checkout) return `gh 写 ${target}，但它不在 ${join(boardDir, 'repos.json')} 登记的仓库里，不知道该用哪个账号：cd 到它的 checkout 里再写`
    let account
    try {
      account = await githubAccountOf(checkout)
    } catch (error) {
      return `${(error as Error).message}；没声明的仓库不许 gh 写操作`
    }
    const leadStart = Math.max(...[...blanked.slice(0, m.index)].map((c, i) => (SEGMENT_START.test(c) ? i + 1 : 0)), 0)
    const lead = cmd.slice(leadStart, m.index)
    const howTo = `这个仓库声明用 ${account} 写 GitHub，写成：${provenPrefix(account)} gh ${segment.trim()}`
    const assignments = (lead.match(TOKEN_ASSIGNMENT) ?? []).length
    if (assignments === 1 && PROVEN_ASSIGNMENT(account).test(lead)) continue
    if (assignments) return `gh 写操作前面的 token 赋值证明不了是 ${account}。${howTo}`
    if (TOKEN_SET_OUTSIDE_A_PROVEN_PREFIX.test(blanked.replaceAll(/\$\(gh auth token --user [\w-]+\)/g, ''))) return `命令里改了 gh 的 token 或账号，核不了这次 gh 写操作用的是谁。${howTo}`
    const effective = await stdoutElseNull('gh', ['auth', 'token'])
    const declared = await stdoutElseNull('gh', ['auth', 'token', '--user', account])
    if (!declared) return `本机 gh 没登录 ${account}：先跑 gh auth login，登录 ${account}`
    if (effective !== declared) return `gh 现在的 token 不是 ${account} 的。${howTo}`
  }
  return null
}
