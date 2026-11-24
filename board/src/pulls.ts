import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const PASSING_CHECK_RUN = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const PENDING_STATUS = ['PENDING', 'EXPECTED']
const GITHUB_PULL_URL_SO_A_HAND_WRITTEN_REF_IS_NEVER_A_GH_FLAG = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/
const READ_TIMEOUT_MS = 5_000
const UNMERGED_READING_FRESH_FOR_MS = 60_000

export type Check = { __typename: 'CheckRun'; name: string; status: string; conclusion: string } | { __typename: 'StatusContext'; context: string; state: string }
export type PullState = 'merged' | 'closed' | 'ci_failed' | 'open'
export type PullStateOf = (url: string) => Promise<PullState | null>

export const checkName = (c: Check) => (c.__typename === 'StatusContext' ? c.context : c.name)
export const checkPassed = (c: Check) => (c.__typename === 'StatusContext' ? c.state === 'SUCCESS' : c.status === 'COMPLETED' && PASSING_CHECK_RUN.includes(c.conclusion))
export const checkSucceeded = (c: Check) => (c.__typename === 'StatusContext' ? c.state === 'SUCCESS' : c.conclusion === 'SUCCESS')
export const checkPending = (c: Check) => (c.__typename === 'StatusContext' ? PENDING_STATUS.includes(c.state) : c.status !== 'COMPLETED')

export const pullStateOfAView = (pr: { state: string; statusCheckRollup?: Check[] | null }): PullState =>
  pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : (pr.statusCheckRollup ?? []).some((c) => !checkPending(c) && !checkPassed(c)) ? 'ci_failed' : 'open'

export const noPullStates: PullStateOf = async () => null

const read = new Map<string, { state: PullState | null; at: number }>()

export const pullStateFromGitHub: PullStateOf = async (url) => {
  if (!GITHUB_PULL_URL_SO_A_HAND_WRITTEN_REF_IS_NEVER_A_GH_FLAG.test(url)) return null
  const had = read.get(url)
  if (had && (had.state === 'merged' || Date.now() - had.at < UNMERGED_READING_FRESH_FOR_MS)) return had.state
  const state = await exec('gh', ['pr', 'view', url, '--json', 'state,statusCheckRollup'], { timeout: READ_TIMEOUT_MS }).then(
    (r) => pullStateOfAView(JSON.parse(r.stdout)),
    () => null,
  )
  read.set(url, { state, at: Date.now() })
  return state
}
