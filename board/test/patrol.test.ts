import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { block, board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { registerSchemas } from '../src/schemas.ts'
import { patrolOnce } from '../src/patrol.ts'

const exec = promisify(execFile)
const MINUTE = 60_000
const ORCH = 'to1'

const HC_STAND_IN_ANSWERING_FROM_FILES_IN_HC_DIR_AND_LOGGING_SENDS = `#!/bin/sh
case "$1" in
  ls) cat "$HC_DIR/ls.json" ;;
  get) cat "$HC_DIR/$2.json" 2>/dev/null || exit 1 ;;
  read) cat "$HC_DIR/$2.read.json" 2>/dev/null || echo '{"text":""}' ;;
  send) printf '%s %s\\n' "$2" "$3" >> "$HC_DIR/sent.log" ;;
esac
`

let team: ReturnType<typeof board>
let tmp = ''
let hcDir = ''
let boardDir = ''
let repo = ''

beforeAll(async () => {
  team = board({ backend: local({ memory: true }) })
  await registerSchemas(team)
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'nawaban-patrol-')))
  hcDir = join(tmp, 'hc')
  await mkdir(hcDir)
  await mkdir(join(tmp, 'bin'))
  await writeFile(join(tmp, 'bin', 'hc'), HC_STAND_IN_ANSWERING_FROM_FILES_IN_HC_DIR_AND_LOGGING_SENDS)
  await chmod(join(tmp, 'bin', 'hc'), 0o755)
  process.env.PATH = `${join(tmp, 'bin')}:${process.env.PATH}`
  process.env.HC_DIR = hcDir
  repo = join(tmp, 'repo')
  await exec('git', ['init', '-q', repo])
})

afterEach(async () => {
  await rm(join(hcDir, 'sent.log'), { force: true })
})

async function freshProject(name: string) {
  boardDir = join(tmp, `board-${name}`)
  await mkdir(boardDir, { recursive: true })
  await writeFile(join(boardDir, 'repos.json'), JSON.stringify({ [name]: repo }))
}

async function terminals(live: Record<string, object>, { orchestrator = true } = {}) {
  const all = { ...(orchestrator ? { [ORCH]: { labels: { role: 'orchestrator' } } } : {}), ...live }
  await writeFile(join(hcDir, 'ls.json'), JSON.stringify({ terminals: Object.keys(all).map((address) => ({ address, state: 'live', cwd: repo })) }))
  for (const [address, got] of Object.entries(all)) await writeFile(join(hcDir, `${address}.json`), JSON.stringify(Object.assign({ labels: {} }, got)))
}

const screen = (address: string, text: string) => writeFile(join(hcDir, `${address}.read.json`), JSON.stringify({ text }))
const atThePrompt = (sinceMs: number, msg = '') => ({ status: { app: 'claude-code', state: 'done', msg }, status_ms: sinceMs })
const sent = async () => (existsSync(join(hcDir, 'sent.log')) ? (await readFile(join(hcDir, 'sent.log'), 'utf8')).trim().split('\n') : [])

async function heldBy(project: string, key: string, terminal: string) {
  const { task } = await team.as(null).tasks.create(project, { id: key, text: key, labels: { key } })
  await team.as('cc-bbbb2222').tasks.claim(task.id, { lease: 3600 })
  await team.label(task.id, { set: { terminal } })
  return task.id
}

it('wakes the orchestrator once for a worker sitting idle at the prompt over 15 minutes while it holds a ticket, with its last line', async () => {
  await freshProject('p-stuck')
  await heldBy('p-stuck', 'S-1', 't11')
  const now = Date.now()
  await terminals({ t11: atThePrompt(now - 25 * MINUTE, 'Push, poll CI') })
  await patrolOnce(team, boardDir, now)
  await patrolOnce(team, boardDir, now + 5 * MINUTE)
  expect(await sent()).toEqual([`${ORCH} 巡检：t11 卡住 25 分钟，持 S-1，最后一行：Push, poll CI`])
})

it('leaves alone a worker still working, one idle under 15 minutes, and one that said 受阻 on its ticket', async () => {
  await freshProject('p-fine')
  await heldBy('p-fine', 'F-1', 't21')
  await heldBy('p-fine', 'F-2', 't22')
  const blocked = await heldBy('p-fine', 'F-3', 't23')
  await team.reply(blocked, '受阻：等 token')
  const now = Date.now()
  await terminals({ t21: { status: { state: 'working' }, status_ms: now - 60 * MINUTE }, t22: atThePrompt(now - 10 * MINUTE), t23: atThePrompt(now - 60 * MINUTE) })
  await patrolOnce(team, boardDir, now)
  expect(await sent()).toEqual([])
})

it('reports a live worker assigned a ticket it has not claimed for 10 minutes', async () => {
  await freshProject('p-unclaimed')
  const { task } = await team.as(null).tasks.create('p-unclaimed', { id: 'U-1', text: 'U-1', labels: { key: 'U-1' } })
  await team.reply(task.id, block('nawaban-dispatch@2', { worker: 'w', terminal: 't31', accept: 'a', orchestrator: ORCH }))
  const now = Date.now()
  await terminals({ t31: atThePrompt(now - 30 * MINUTE) })
  await screen('t31', '⏺ 已合 PR #5\n────────\n')
  await patrolOnce(team, boardDir, now + 5 * MINUTE)
  expect(await sent()).toEqual([])
  await patrolOnce(team, boardDir, now + 11 * MINUTE)
  expect(await sent()).toEqual([`${ORCH} 巡检：t31 被指派 U-1 11 分钟没认领，最后一行：⏺ 已合 PR #5`])
})

it('leaves alone a ticket queued for a worker still busy holding another, as dispatch means it to', async () => {
  await freshProject('p-queued')
  await heldBy('p-queued', 'B-1', 't32')
  const { task } = await team.as(null).tasks.create('p-queued', { id: 'B-2', text: 'B-2', labels: { key: 'B-2' } })
  await team.reply(task.id, block('nawaban-dispatch@2', { worker: 'w', terminal: 't32', accept: 'a', orchestrator: ORCH }))
  const now = Date.now()
  await terminals({ t32: { status: { state: 'working' }, status_ms: now } })
  await patrolOnce(team, boardDir, now + 30 * MINUTE)
  expect(await sent()).toEqual([])
})

it('keeps what it already said when hc cannot read the terminal for a round, so the same problem is not said twice', async () => {
  await freshProject('p-flaky')
  await heldBy('p-flaky', 'K-1', 't91')
  const now = Date.now()
  await terminals({ t91: atThePrompt(now - 20 * MINUTE, 'idle') })
  await patrolOnce(team, boardDir, now)
  await writeFile(join(hcDir, 't91.json'), 'not json')
  await patrolOnce(team, boardDir, now + 5 * MINUTE)
  await terminals({ t91: atThePrompt(now - 20 * MINUTE, 'idle') })
  await patrolOnce(team, boardDir, now + 10 * MINUTE)
  expect(await sent()).toEqual([`${ORCH} 巡检：t91 卡住 20 分钟，持 K-1，最后一行：idle`])
})

it('reports a ticket still held by a terminal that is gone', async () => {
  await freshProject('p-gone')
  await heldBy('p-gone', 'G-1', 't41')
  await terminals({})
  await patrolOnce(team, boardDir, Date.now())
  expect(await sent()).toEqual([`${ORCH} 巡检：t41 终端已死，还持 G-1`])
})

it('marks a worker out of quota apart from stuck, at once, and reports again when it later just sits idle', async () => {
  await freshProject('p-quota')
  await heldBy('p-quota', 'Q-1', 't51')
  const now = Date.now()
  await terminals({ t51: atThePrompt(now - 2 * MINUTE) })
  await screen('t51', "You've hit your usage limit · resets 3pm\n> \n")
  await patrolOnce(team, boardDir, now)
  await patrolOnce(team, boardDir, now + MINUTE)
  await screen('t51', '⏺ waiting\n')
  await patrolOnce(team, boardDir, now + 20 * MINUTE)
  expect(await sent()).toEqual([
    `${ORCH} 巡检：t51 额度用完，持 Q-1，最后一行：You've hit your usage limit · resets 3pm`,
    `${ORCH} 巡检：t51 卡住 22 分钟，持 Q-1，最后一行：⏺ waiting`,
  ])
})

it('does not report again after a restart, since what it said lives in the board folder', async () => {
  await freshProject('p-restart')
  await heldBy('p-restart', 'R-1', 't61')
  await terminals({})
  await patrolOnce(team, boardDir, Date.now())
  vi.resetModules()
  const { patrolOnce: patrolOnceAfterRestart } = await import('../src/patrol.ts')
  expect(patrolOnceAfterRestart).not.toBe(patrolOnce)
  await patrolOnceAfterRestart(team, boardDir, Date.now())
  expect(await sent()).toEqual([`${ORCH} 巡检：t61 终端已死，还持 R-1`])
})

it('records the finding on the ticket when the repository has no live orchestrator, once', async () => {
  await freshProject('p-alone')
  const id = await heldBy('p-alone', 'A-1', 't71')
  await terminals({}, { orchestrator: false })
  await patrolOnce(team, boardDir, Date.now())
  await patrolOnce(team, boardDir, Date.now())
  expect(await sent()).toEqual([])
  expect((await team.thread(id)).replies.map((r) => r.text)).toEqual(['巡检：t71 终端已死，还持 A-1'])
})

it('skips the round when hc cannot list terminals, rather than calling every holder gone', async () => {
  await freshProject('p-nohc')
  await heldBy('p-nohc', 'N-1', 't81')
  await writeFile(join(hcDir, 'ls.json'), 'not json')
  await patrolOnce(team, boardDir, Date.now())
  expect(await sent()).toEqual([])
})
