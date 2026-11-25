import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Refused } from './said.ts'

export const ACCOUNT_DECLARED_IN = 'docs/agents/issue-tracker.md'
const FENCED_OR_COMMENTED_EXAMPLE_UNCLOSED_RUNS_TO_THE_END = /^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1|$(?![\s\S]))|<!--[\s\S]*?(?:-->|$(?![\s\S]))/gm
const DECLARATION = /^github-account:[ \t]*([A-Za-z0-9-]+)[ \t]*$/m
const run = promisify(execFile)

export async function githubAccountOf(repo: string): Promise<string> {
  const text = (await readFile(join(repo, ACCOUNT_DECLARED_IN), 'utf8').catch(() => '')).replace(FENCED_OR_COMMENTED_EXAMPLE_UNCLOSED_RUNS_TO_THE_END, '')
  const account = DECLARATION.exec(text)?.[1]
  if (!account) throw new Refused(`${repo} 没声明用哪个 GitHub 账号写：在 ${ACCOUNT_DECLARED_IN} 加一行 github-account: <账号>`)
  return account
}

export async function githubTokenOf(repo: string): Promise<string> {
  const account = await githubAccountOf(repo)
  const token = (await run('gh', ['auth', 'token', '--user', account]).catch(() => null))?.stdout.trim()
  if (!token) throw new Refused(`本机 gh 没登录 ${repo} 声明的账号 ${account}：先跑 gh auth login，登录 ${account}`)
  return token
}

export const ghEnvOf = async (repo: string) => ({ ...process.env, GH_TOKEN: await githubTokenOf(repo) })
