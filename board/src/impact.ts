import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { board, Middleware, MessageView } from '@vercel/board'
import { findBlocks } from '@vercel/board/schemas'
import { parse } from 'smol-toml'
import { githubIssueOfTask } from './github-tasks.ts'
import { UNMEASURED } from './schemas.ts'

type Team = ReturnType<typeof board>
type Impact = { objective: string; krs: { name: string; dir?: string; before?: string; after?: string }[] }
type Registered = { schema: string; version: number; data: unknown }
type Heading = { name: string; heading: 'toward' | 'away' | 'hold' }
type PullRequest = { number: number; title: string; body: string; headRefName: string }

export const OKR_FILE = 'docs/agents/okr.toml'
export const IMPACT_FORMAT = '<KR 名>=toward|away|hold'
export const RESULT_FORMAT = `<KR 名>=<后值> 实测|预计，没有读数写 <KR 名>=${UNMEASURED}`
const NUMBER = /^-?\d+(?:\.\d+)?%?$/
const NO_OBJECTIVE_PURE_INFRASTRUCTURE = '无'
const TASKS_PAGE = 50
const BOARD_ID_WIDTH_SO_LOG_INDEX_SORTS_AS_TEXT = 20
const run = promisify(execFile)

const MERGE_IN_COMMAND_POSITION =
  /(?:^|[;&|(\n])\s*(?:\w+=(?:\$\([^)]*\)|\S*)\s+)*(?:gh(?:\s+(?:-R|--repo)(?:\s+|=)\S+)*\s+pr\s+merge|(?:(?:ba|z)?sh\s+)?(?:\S*\/)?scripts\/merge\.sh)(?=[\s;&|)]|$)/g
const BOARD_CLI_CLOSING_TASK_IN_COMMAND_POSITION =
  /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:(?:npx|bunx|pnpm|yarn|exec|dlx|node|vercel)(?:\s+-\S+)*\s+)*(?:\S*\/)?(?:vb|board|nawaban|cli\.ts|@vercel\/board(?:@\S*)?)\s+(?:[^;&|\n)]*\s)?tasks\s+(?:complete|fail|cancel)(?=[\s;&|)]|$)/
const GH_REPO_FLAG_BEFORE_PR_MERGE = /(?:-R|--repo)(?:\s+|=)(\S+)/
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit'])

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export async function reposReadOnEveryUseSoEditsNeedNoRestart(dir: string): Promise<Record<string, string>> {
  try {
    const map = JSON.parse(await readFile(join(dir, 'repos.json'), 'utf8'))
    return Object.fromEntries(Object.entries(map).filter(([, path]) => typeof path === 'string').map(([k, path]) => [k, resolve((path as string).replace(/^~(?=\/|$)/, homedir()))]))
  } catch (error) {
    if (missing(error)) return {}
    throw new Error(`${join(dir, 'repos.json')} isn't a JSON object of project to repository path: ${(error as Error).message}`)
  }
}

async function objectivesWithKrNamesOrNull(repo: string): Promise<Map<string, string[]> | null> {
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
  for (const [name, path] of Object.entries(await reposReadOnEveryUseSoEditsNeedNoRestart(dir))) if ((await real(path)) === here) project = name
  return project
}

async function checkoutsOf(repo: string) {
  const listed = (await run('git', ['-C', repo, 'worktree', 'list', '--porcelain']).catch(() => null))?.stdout ?? ''
  return [...new Set([repo, ...[...listed.matchAll(/^worktree (.+)$/gm)].map((m) => m[1]!)])]
}

export async function okrOf(dir: string, channel: string) {
  const repo = (await reposReadOnEveryUseSoEditsNeedNoRestart(dir))[channel]
  if (!repo) return null
  const aBranchAddingAnObjectiveRegistersBeforeItMerges = (await Promise.all((await checkoutsOf(repo)).map(objectivesWithKrNamesOrNull))).filter((okr) => okr !== null)
  if (!aBranchAddingAnObjectiveRegistersBeforeItMerges.length) return null
  const names = new Map<string, string[]>()
  for (const okr of aBranchAddingAnObjectiveRegistersBeforeItMerges) for (const [o, krs] of okr) names.set(o, [...new Set([...(names.get(o) ?? []), ...krs])])
  return names
}

function whyNotDeclarableIn(channel: string, impact: Impact, okr: Map<string, string[]> | null, dir: string): string | null {
  const o = impact.objective
  if (o === NO_OBJECTIVE_PURE_INFRASTRUCTURE) return impact.krs.length ? '--o 无 不带 --kr' : null
  if (!okr) return `项目 ${channel} 没有 ${OKR_FILE}(仓库路径登记在 ${join(dir, 'repos.json')}),只能 --o 无`
  const names = okr.get(o)
  if (!names) return `${OKR_FILE} 里没有这个 O:${o}(有:${[...okr.keys()].join('、')})`
  for (const kr of impact.krs) {
    if (!names.includes(kr.name)) return `${o} 下没有这个 KR:${kr.name}(有:${names.join('、')})`
    if (kr.dir !== undefined && kr.dir !== '=' && !(NUMBER.test(kr.before!) && NUMBER.test(kr.after!))) return `↑↓ 的前后值要是数字:${kr.name}=${kr.dir} ${kr.before}→${kr.after}`
  }
  return null
}

export async function whyNotDeclarable(dir: string, channel: string, impact: Impact) {
  return whyNotDeclarableIn(channel, impact, await okrOf(dir, channel), dir)
}

export function impactNames(dir: string): Middleware {
  return async ({ write, respond, next }) => {
    const shapeCheckedByBoard = findBlocks(write.text).filter((b) => b.name === 'nawaban-impact' && b.data)
    if (!shapeCheckedByBoard.length) return next()
    let whyDropWhoeverWroteIt
    try {
      const okr = await okrOf(dir, write.channel)
      whyDropWhoeverWroteIt = shapeCheckedByBoard.map((b) => whyNotDeclarableIn(write.channel, b.data as Impact, okr, dir)).find(Boolean)
    } catch (error) {
      whyDropWhoeverWroteIt = `核不了 KR 影响声明:${(error as Error).message}`
    }
    if (whyDropWhoeverWroteIt) return respond(whyDropWhoeverWroteIt)
    return next()
  }
}

export const howToDeclare = (ref: string) =>
  `  nawaban event ${ref} impact --o "<O 名>" --kr "${IMPACT_FORMAT}" [--change measure|gold](--kr 可重复;纯基础设施写 --o 无;认领时就登记:nawaban claim ${ref} --o … --kr …)`

async function blocksOnTheTaskAndItsIssueRoot(team: Team, task: MessageView) {
  const replies: MessageView[] = []
  for (const id of [task.id, task.labels['issue-root']].filter((id) => id !== undefined)) replies.push(...(await team.thread(id)).replies)
  return blocksOldestFirst(replies)
}

const krNamesIn = (blocks: Registered[]) => blocks.flatMap((b) => (b.data as { krs: { name: string }[] }).krs.map((k) => k.name))

export const onTheOneClock = (m: MessageView) => `${m.createdAt}~${m.id.padStart(BOARD_ID_WIDTH_SO_LOG_INDEX_SORTS_AS_TEXT, '0')}`

const blocksOldestFirst = (replies: MessageView[]) =>
  replies
    .filter((r) => !r.deleted)
    .map((r) => [onTheOneClock(r), r] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([, r]) => r.blocks)

function krsTheLatestImpactLeavesUnreported(blocks: Registered[]) {
  const at = blocks.findLastIndex((b) => b.schema === 'nawaban-impact' && b.data && b.version === 2)
  if (at < 0) return []
  const latest = blocks[at]!
  const reported = new Set(krNamesIn(blocks.slice(at + 1).filter((b) => b.schema === 'nawaban-impact-result' && b.data)))
  return (latest.data as { krs: Heading[] }).krs.filter((kr) => kr.heading !== 'hold' && !reported.has(kr.name)).map((kr) => kr.name)
}

const krResultFlags = (names: string[]) => names.map((n) => `--kr "${n}=<后值> 实测|预计"`).join(' ')

export async function undeclared(team: Team, id: string, dir: string): Promise<string | null> {
  const { message, replies } = await team.thread(id)
  if (!(await okrOf(dir, message.channel))) return null
  const ref = message.labels.key ?? id
  const blocks = blocksOldestFirst(replies)
  const declared = blocks.filter((b) => b.schema === 'nawaban-impact' && b.data)
  if (!declared.length) return `${ref} 没有 KR 影响声明,不能 close --done。先补:\n${howToDeclare(ref)}`
  const unreported = krsTheLatestImpactLeavesUnreported(blocks)
  if (!unreported.length) return null
  return `${ref} 登记了 KR 却没补结果(${unreported.join('、')}),不能 close --done。关票时补:\n  nawaban close ${ref} --done ${krResultFlags(unreported)}`
}

const quotedStringsBlankedSoAMentionIsNeverACommand = (cmd: string) => cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (q) => "'" + 'x'.repeat(q.length - 2) + "'")

export function closeGate(cmd: string): string | null {
  return BOARD_CLI_CLOSING_TASK_IN_COMMAND_POSITION.test(quotedStringsBlankedSoAMentionIsNeverACommand(cmd))
    ? 'agent 不直接调 tasks complete|fail|cancel:关单用 nawaban close <key> --done|--cancelled(有 okr.toml 的项目,--done 要先有 KR 影响声明)'
    : null
}

export const words = (s: string) => s.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g)?.map((w) => w.replace(/^(['"])(.*)\1$/s, '$2')) ?? []

async function mainCheckoutOfSessionCwd(cwd: string): Promise<string | null> {
  const common = (await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd }).catch(() => null))?.stdout.trim()
  return common ? resolve(common, '..') : null
}

export async function projectOfThisRepository(boardDir: string, cwd = process.cwd()): Promise<string | undefined> {
  const top = await mainCheckoutOfSessionCwd(cwd)
  return top ? projectOf(boardDir, top) : undefined
}

function prSelectorAndRepo(cmd: string, blanked: string, m: RegExpExecArray): { sel: string | undefined; repo: string | undefined } {
  const end = m.index + m[0].length
  const stop = blanked.slice(end).search(/[;&|\n)]|$/)
  const args = words(cmd.slice(end, end + stop))
  let sel: string | undefined
  let repo = GH_REPO_FLAG_BEFORE_PR_MERGE.exec(cmd.slice(m.index, end))?.[1]
  for (let i = 0; i < args.length; i++) {
    if (GH_VALUE_FLAGS.has(args[i]!)) {
      if (args[i] === '-R' || args[i] === '--repo') repo = args[i + 1]
      i++
    } else if (!args[i]!.startsWith('-') && sel === undefined) sel = args[i]
  }
  return { sel, repo }
}

async function pullRequestOrWhyNot(sel: string | undefined, repo: string | undefined, cwd: string): Promise<PullRequest | string> {
  try {
    const view = ['pr', 'view', ...(sel ? [sel] : []), ...(repo ? ['--repo', repo] : []), '--json', 'number,title,body,headRefName']
    return JSON.parse((await run('gh', view, { cwd })).stdout)
  } catch (error) {
    return `查不到这个 PR,核不了 KR 影响声明:${(error as Error).message.trim()}`
  }
}

const namesKeyAsWholeWord = (text: string, key: string) => new RegExp(`(?<![\\w-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(text)

const WHAT_A_CLOSES_OR_REFS_LINE_POINTS_AT = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b[:：]?[ \t]+([\w#-]+(?:[ \t]*(?:[,，、]|\band\b)[ \t]*[\w#-]+)*)/gi

const ticketsThePullRequestIsFor = (pr: PullRequest) =>
  [pr.title, pr.headRefName, ...[...(pr.body ?? '').matchAll(WHAT_A_CLOSES_OR_REFS_LINE_POINTS_AT)].map((m) => m[1]!)].join(' ')

export function tasksThePullRequestNames(pr: PullRequest, tasks: MessageView[]) {
  const text = ticketsThePullRequestIsFor(pr)
  return tasks.filter((t) => {
    const key = t.labels.key
    const issue = githubIssueOfTask(t)
    return !!key && (namesKeyAsWholeWord(text, key) || (issue !== null && namesKeyAsWholeWord(text, `#${issue}`)))
  })
}

async function whyThisMergeMustWait(team: Team, project: string, pr: PullRequest): Promise<string | null> {
  const named = tasksThePullRequestNames(pr, await tasksADeclarationCanStillBeOn(team, project))
  if (!named.length) return `PR #${pr.number} 没写到项目 ${project} 的任何一张票(标题、分支名里写票号，或正文写 Closes/Refs <票号>),核不了 KR 影响声明`
  const missed = []
  const unreported = []
  for (const t of named) {
    const blocks = await blocksOnTheTaskAndItsIssueRoot(team, t)
    if (!blocks.some((b) => b.schema === 'nawaban-impact')) missed.push(t.labels.key!)
    const names = krsTheLatestImpactLeavesUnreported(blocks)
    if (names.length) unreported.push(`  nawaban event ${t.labels.key} result ${krResultFlags(names)}`)
  }
  if (missed.length) return `PR #${pr.number} 的关联票没有 KR 影响声明(${missed.join('、')}),先补再合并:\n${missed.map(howToDeclare).join('\n')}`
  if (unreported.length) return `PR #${pr.number} 的关联票登记了 KR 却没报结果,合并前先报:\n${unreported.join('\n')}`
  return null
}

export async function mergeGate(cmd: string, cwd: string, team: Team, dir: string): Promise<string | null> {
  const blanked = quotedStringsBlankedSoAMentionIsNeverACommand(cmd)
  const merges = [...blanked.matchAll(MERGE_IN_COMMAND_POSITION)]
  if (!merges.length) return null
  const top = await mainCheckoutOfSessionCwd(cwd)
  if (!top) return null
  const project = await projectOf(dir, top)
  const leftToTheOldGate = !project
  if (leftToTheOldGate || !(await objectivesWithKrNamesOrNull(top))) return null
  for (const m of merges) {
    const { sel, repo } = prSelectorAndRepo(cmd, blanked, m)
    if (sel === undefined && m[0].includes('merge.sh')) return 'scripts/merge.sh 没写 PR 号,核不了 KR 影响声明'
    const pr = await pullRequestOrWhyNot(sel, repo, cwd)
    if (typeof pr === 'string') return pr
    const why = await whyThisMergeMustWait(team, project, pr)
    if (why) return why
  }
  return null
}

async function tasksADeclarationCanStillBeOn(team: Team, channel: string) {
  const uncanceledDoneKeepsItsDeclaration: MessageView[] = []
  for (let after: string | undefined; ; ) {
    const page = await team.tasks.list({ channel, state: 'all', after, limit: TASKS_PAGE })
    uncanceledDoneKeepsItsDeclaration.push(...page.tasks.map((t) => t.message).filter((m) => m.task?.state !== 'canceled'))
    if (page.tasks.length < TASKS_PAGE) return uncanceledDoneKeepsItsDeclaration
    after = page.cursor
  }
}
