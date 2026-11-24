import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reposReadOnEveryUseSoEditsNeedNoRestart } from './impact.ts'
import { Refused } from './tasks.ts'

const OLD_CLI = fileURLToPath(new URL('../../nawaban/cli.py', import.meta.url))
const ISSUE_TRACKER = 'docs/agents/issue-tracker.md'
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024
const BOARD_FRESH_FOR_MS = 30_000
const MARKS_OF_AN_AGENT_SESSION = ['HC_TERMINAL_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'ANTIGRAVITY_CONVERSATION_ID']
export const ISSUE_KEY = /^#\d+$/

export type OldCli = (repo: string, args: string[]) => Promise<string>
type GithubTask = { status: string; pending?: unknown; waiting?: unknown }
export type GithubBoard = { columns: { key: string; tasks: GithubTask[] }[] }

export const theWebTokenHolderAtAShell = (user = userInfo().username) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !MARKS_OF_AN_AGENT_SESSION.includes(name))),
  NAWABAN_OWNER: user,
})

const refusalIn = (stdout: string, stderr: string) => {
  try {
    return String(JSON.parse(stdout).error)
  } catch {
    return stderr.trim().replace(/^✗ /, '') || stdout.trim()
  }
}

export const oldCli: OldCli = (repo, args) =>
  new Promise((done, fail) =>
    execFile('python3', [OLD_CLI, ...args], { cwd: repo, env: theWebTokenHolderAtAShell(), maxBuffer: OUTPUT_MAX_BYTES }, (error, stdout, stderr) =>
      error ? fail(error.code === 'ENOENT' ? error : new Refused(refusalIn(stdout, stderr))) : done(stdout),
    ),
  )

async function tracksOnGithub(repo: string) {
  try {
    const heading = (await readFile(join(repo, ISSUE_TRACKER), 'utf8')).split('\n').find((line) => line.startsWith('#')) ?? ''
    return heading.includes('GitHub')
  } catch {
    return false
  }
}

export async function githubRepos(dir: string): Promise<Record<string, string>> {
  const repos = Object.entries(await reposReadOnEveryUseSoEditsNeedNoRestart(dir))
  const onGithub = await Promise.all(repos.map(([, repo]) => tracksOnGithub(repo)))
  return Object.fromEntries(repos.filter((_, i) => onGithub[i]))
}

export function githubBoards(cli: OldCli, now = () => Date.now()) {
  const reads = new Map<string, { at: number; board: Promise<GithubBoard> }>()
  const latest = new Map<string, GithubBoard>()
  return {
    board(repo: string) {
      const had = reads.get(repo)
      if (had && now() - had.at < BOARD_FRESH_FOR_MS) return had.board
      const read = { at: now(), board: cli(repo, ['json', 'board']).then((out) => JSON.parse(out) as GithubBoard) }
      reads.set(repo, read)
      read.board.then(
        (board) => latest.set(repo, board),
        () => reads.get(repo) === read && reads.delete(repo),
      )
      return read.board
    },
    latest: (repo: string) => latest.get(repo) ?? null,
    forget: (repo: string) => void reads.delete(repo),
  }
}

export function projectOfGithub(name: string, board: GithubBoard | null) {
  const tasks = (board?.columns ?? []).flatMap((c) => c.tasks)
  const open = tasks.filter((t) => t.status !== 'done')
  return { name, open: open.length, total: tasks.length, waiting: open.filter((t) => t.pending || t.waiting).length }
}
