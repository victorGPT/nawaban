import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { text as wholeOf } from 'node:stream/consumers'
import { promisify } from 'node:util'
import { block, BoardError, type board } from '@vercel/board'
import { issueRoot, saidAsAHook } from './github-push.ts'
import { githubSyncConfigToPoll } from './github-sync-status.ts'
import { keyOf, TITLE_AWAITS_GITHUB } from './github-tasks.ts'
import { projectOf } from './impact.ts'
import { Refused } from './said.ts'

type Person = ReturnType<typeof board>
export type OldImpactRow = { repo: string; ticket: string; objective: string; kr: string; dir: string; before: string | null; after: string | null; basis: string | null; declared_at: string }

export const GITHUB_ISSUE_TICKET = /^#(\d+)$/
const ID_HASH_LENGTH = 32
const GITHUB_REPO_IN_REMOTE = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/
const run = promisify(execFile)

const hashOf = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, ID_HASH_LENGTH)

export const declarationId = (i: Pick<OldImpactRow, 'repo' | 'ticket' | 'objective' | 'declared_at'>) => 'import-impact-' + hashOf(i.repo, i.ticket, i.objective, i.declared_at)

export const oldRowsAsDeclaration = (rows: OldImpactRow[]) =>
  block('nawaban-impact@1', {
    objective: rows[0]!.objective,
    krs: rows.filter((r) => r.kr).map((r) => Object.fromEntries(Object.entries({ name: r.kr, dir: r.dir, before: r.before, after: r.after, basis: r.basis }).filter(([, v]) => v !== null))),
  })

export async function githubRepoOfChannel(dir: string, channel: string, checkout?: string) {
  const configured = Object.entries((await githubSyncConfigToPoll(dir))?.repos ?? {}).find(([, c]) => c === channel)?.[0]
  if (configured || !checkout) return configured ?? null
  const remote = await run('git', ['-C', checkout, 'remote', 'get-url', 'origin']).then((r) => r.stdout, () => '')
  return GITHUB_REPO_IN_REMOTE.exec(remote)?.[1] ?? null
}

async function issueThreadTheSyncWillReuse(person: Person, channel: string, repo: string, issue: number) {
  const found = await issueRoot(person, channel, repo, issue)
  if (found && !found.labels[TITLE_AWAITS_GITHUB]) return found
  const root =
    found ??
    (await person.post(channel, {
      id: 'issue-root-' + hashOf(repo, String(issue)),
      text: `Issue #${issue}\nhttps://github.com/${repo}/issues/${issue}`,
      labels: { issue: `${repo}#${issue}`, key: keyOf(channel, issue), [TITLE_AWAITS_GITHUB]: 'yes' },
    }))
  await person.sync(root.id, `github:${repo}:issue:${issue}`)
  return root
}

export async function declareOnIssueThread(person: Person, channel: string, repo: string, rows: OldImpactRow[]) {
  const id = declarationId(rows[0]!)
  const already = await person.posted(id).then(
    () => true,
    (error) => {
      if (error instanceof BoardError && error.code === 'post_not_found') return false
      throw error
    },
  )
  if (already) return false
  const root = await issueThreadTheSyncWillReuse(person, channel, repo, Number(GITHUB_ISSUE_TICKET.exec(rows[0]!.ticket)![1]))
  await person.reply(root.id, { id, text: oldRowsAsDeclaration(rows) })
  return true
}


export const githubImpactHook = (argv: string[], person: Person, dir: string) =>
  saidAsAHook(async () => {
    if (argv.length) throw new Refused('用法：nawaban hook github-impact，旧 CLI 的 kr_impacts 行（JSON 数组）从标准输入读')
    const rows = JSON.parse(await wholeOf(process.stdin)) as OldImpactRow[]
    const ticket = rows[0]?.ticket ?? ''
    if (!GITHUB_ISSUE_TICKET.test(ticket)) throw new Refused(`只记 GitHub issue 的声明（#N），收到 ${ticket || '空'}`)
    const channel = await projectOf(dir, rows[0]!.repo)
    if (!channel) throw new Refused(`仓库 ${rows[0]!.repo} 不在板的 repos.json`)
    const repo = await githubRepoOfChannel(dir, channel)
    if (!repo) throw new Refused(`${channel} 不在本机 github-sync.json 的 repos 里：板上不记它的 GitHub 声明`)
    const made = await declareOnIssueThread(person, channel, repo, rows)
    return made ? `影响声明记在板上（${repo}${ticket}）` : `影响声明板上已有（${repo}${ticket}）`
  })
