import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { listen, verifier } from '../src/server.ts'
import { registerSchemas } from '../src/schemas.ts'
import { INBOX_OPEN, inboxChannel, inboxItemText, webAnswerText } from '../src/page.ts'

const ROOT = new URL('../..', import.meta.url).pathname
const PLUGIN_HOOKS_RUN_AS_CLAUDE_CODE_RUNS_THEM = join(ROOT, 'hooks')
const CLI = join(ROOT, 'board/src/cli.ts')
const SECRET = 'test-secret'
const SESSION = 'aaaa1111-0000-0000-0000-000000000000'
const AS = 'cc-aaaa1111'
const sh = promisify(execFile)
const EVERY_STEP_STARTS_A_NODE_OR_A_SHELL = { timeout: 60_000 }
let team: ReturnType<typeof board>
let server: Awaited<ReturnType<typeof listen>>
let env: Record<string, string> = {}
let repo = ''
let tmp = ''

beforeAll(async () => {
  server = await listen((request) => team.fetch(request), 0)
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/board`
  team = board({ backend: local({ memory: true }), authenticate: verifier(SECRET, 'victor'), url })
  await registerSchemas(team)
  tmp = await mkdtemp(join(tmpdir(), 'nawaban-hooks-'))
  const fakeHcWhoseRoleLabelIsRole = `#!/bin/sh\necho "{\\"labels\\":{\\"role\\":\\"$ROLE\\"},\\"pid\\":${process.pid}}"\n`
  const fakeGhRecordingCallsReachingNoGitHub = `#!/bin/sh\necho "$@" >> ${tmp}/gh.log\necho gh down >&2\nexit 1\n`
  await mkdir(join(tmp, 'bin'))
  await writeFile(join(tmp, 'bin/hc'), fakeHcWhoseRoleLabelIsRole)
  await writeFile(join(tmp, 'bin/gh'), fakeGhRecordingCallsReachingNoGitHub)
  await Promise.all(['hc', 'gh'].map((b) => chmod(join(tmp, 'bin', b), 0o755)))
  repo = join(tmp, 'proj')
  await mkdir(join(repo, 'docs/agents'), { recursive: true })
  await writeFile(join(repo, 'docs/agents/orchestrator.md'), '规矩正文\n')
  await writeFile(join(repo, 'docs/agents/okr.toml'), '')
  await sh('git', ['init', '-q', '-b', 'main', repo])
  const boardKnowsProjsCheckoutSoItsMergeGateReadsProjsOkrToml = JSON.stringify({ proj: repo })
  await mkdir(join(tmp, 'board'))
  await writeFile(join(tmp, 'board/repos.json'), boardKnowsProjsCheckoutSoItsMergeGateReadsProjsOkrToml)
  env = {
    PATH: `${join(tmp, 'bin')}:${process.env.PATH}`,
    HOME: tmp,
    BOARD_URL: url,
    BOARD_TOKEN: SECRET,
    NAWABAN_BOARD_DIR: join(tmp, 'board'),
    XDG_CONFIG_HOME: join(tmp, 'config'),
    CLAUDE_CODE_SESSION_ID: SESSION,
    HC_TERMINAL_ID: 't1',
    CLAUDE_PROJECT_DIR: repo,
    NAWABAN_CLI: 'board',
    ROLE: 'orchestrator',
  }
})
afterAll(() => server.close())

async function runWithTheHooksEnvironment(what: string[], input = '', more: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = execFile(what[0]!, what.slice(1), { cwd: repo, env: { ...env, ...more } }, (error, out, err) =>
      resolve({ code: error ? Number(error.code) : 0, out, err }),
    )
    child.stdin!.end(input)
  })
}
const nawaban = async (...argv: string[]) => {
  const r = await runWithTheHooksEnvironment(['node', CLI, ...argv])
  expect(r.code, `${argv.join(' ')}: ${r.err}`).toBe(0)
  return r.out
}
const hook = (name: string, input: unknown = '', more: Record<string, string> = {}) =>
  runWithTheHooksEnvironment(['sh', join(PLUGIN_HOOKS_RUN_AS_CLAUDE_CODE_RUNS_THEM, name)], typeof input === 'string' ? input : JSON.stringify(input), more)
const inbox = async (session: string, more: Record<string, string> = {}) => {
  const r = await hook('inbox.sh', { session_id: session, cwd: repo, stop_hook_active: false }, more)
  expect(r.code).toBe(0)
  return r.out.trim() ? (JSON.parse(r.out).systemMessage as string) : null
}
const idOf = async (key: string) => (await team.tasks.list({ state: 'all', label: { key } })).tasks[0]!.message.id

it('routes a repository to the board unless the old CLI already tracks it', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const route = async (dir: string, more: Record<string, string> = {}) =>
    (await runWithTheHooksEnvironment(['node', join(PLUGIN_HOOKS_RUN_AS_CLAUDE_CODE_RUNS_THEM, 'route.mjs'), dir], '', { NAWABAN_CLI: '', ...more })).out
  const newRepo = async (name: string) => {
    const dir = join(tmp, 'routes', name)
    await mkdir(dir, { recursive: true })
    await sh('git', ['init', '-q', '-b', 'main', dir])
    return dir
  }
  const fresh = await newRepo('fresh')
  const withOldBoard = await newRepo('withold')
  await mkdir(join(withOldBoard, '.nawaban'))
  await writeFile(join(withOldBoard, '.nawaban/nawaban.db'), '')
  const besideAFileNamedNawaban = join(tmp, 'routes', 'nested', 'inner')
  await mkdir(join(tmp, 'routes', 'nested', '.nawaban'), { recursive: true })
  await writeFile(join(tmp, 'routes', 'nested', '.nawaban/nawaban.db'), '')
  await mkdir(besideAFileNamedNawaban, { recursive: true })
  await sh('git', ['init', '-q', '-b', 'main', besideAFileNamedNawaban])
  await writeFile(join(besideAFileNamedNawaban, '.nawaban'), '')
  const onGithub = await newRepo('ongithub')
  await mkdir(join(onGithub, 'docs/agents'), { recursive: true })
  await writeFile(join(onGithub, 'docs/agents/issue-tracker.md'), '# Issue tracker: GitHub\n')

  expect(await route(fresh)).toBe('board fresh\n')
  expect(await route(join(fresh, '.git'))).toBe('board fresh\n')
  expect(await route(withOldBoard)).toBe('old\n')
  expect(await route(onGithub)).toBe('old\n')
  expect(await route(besideAFileNamedNawaban)).toBe('old\n')
  expect(await route(fresh, { NAWABAN_DB: join(withOldBoard, '.nawaban/nawaban.db') })).toBe('old\n')
  expect(await route(fresh, { NAWABAN_CLI: 'old' })).toBe('old\n')
  expect(await route(withOldBoard, { NAWABAN_CLI: 'board' })).toBe('board withold\n')
  expect(await route(tmp)).toBe('old\n')
})

it('routes a GitHub repository to the board once this machine has synced every open issue there, and leaves it on the old CLI elsewhere', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const route = async (...args: string[]) => (await runWithTheHooksEnvironment(['node', join(PLUGIN_HOOKS_RUN_AS_CLAUDE_CODE_RUNS_THEM, 'route.mjs'), ...args], '', { NAWABAN_CLI: '', NAWABAN_BOARD_DIR: syncDir })).out
  const roubao = join(tmp, 'synced', 'roubao')
  await mkdir(join(roubao, 'docs/agents'), { recursive: true })
  await sh('git', ['init', '-q', '-b', 'main', roubao])
  await writeFile(join(roubao, 'docs/agents/issue-tracker.md'), '# Issue tracker: GitHub\n')
  const syncDir = join(tmp, 'synced', 'board')
  await mkdir(syncDir, { recursive: true })
  expect(await route(roubao)).toBe('old\n')
  await writeFile(join(syncDir, 'github-sync.json'), JSON.stringify({ repos: { 'acme/roubao': 'roubao' }, reader: 'someone' }))
  expect(await route(roubao)).toBe('old\n')
  await mkdir(join(syncDir, 'github-sync'))
  await writeFile(join(syncDir, 'github-sync', 'acme%2Froubao.switched.json'), '{}')
  expect(await route(roubao)).toBe('board roubao\n')
})

it('prints the index off the board when an orchestrator window starts, and nothing in any other window', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  await nawaban('create', 'K1', '--title', '要密钥', '--project', 'proj')
  await nawaban('create', 'K2', '--title', '在干的', '--project', 'proj')
  await nawaban('claim', 'K2')
  await nawaban('event', await idOf('K2'), '--kind', 'note', '--body', '写完测试，下一步：接 CLI。', '--as', AS)
  const start = await hook('leader-index.sh')
  expect(start.code, start.err).toBe(0)
  expect(start.out).toContain('proj 进行中的事')
  expect(start.out).toContain('进行中 1 · 待办 1')
  expect(start.out).toContain('## 进行中\n- K2 在干的\n  进展 0 分钟前：写完测试\n  下一步：接 CLI')
  expect(start.out).toContain('- K1 要密钥')
  expect(start.out).toContain('规矩正文')
  expect(start.err).not.toContain('改用')
  expect((await hook('leader-index.sh', '', { ROLE: 'worker' })).out).toBe('')
})

it('reads the index of the repository the session is in, not of the folder Claude Code was launched from', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const launchedInHomeNotTheRepository = { CLAUDE_PROJECT_DIR: tmp }
  const start = await hook('leader-index.sh', { session_id: SESSION, cwd: join(repo, 'docs') }, launchedInHomeNotTheRepository)
  expect(start.out).toContain('proj 进行中的事')
  expect(start.out).toContain('规矩正文')
  const declared = await hook('orchestrator-declare.sh', { session_id: SESSION, cwd: repo, prompt: '/nawaban:orchestrator' }, launchedInHomeNotTheRepository)
  expect(declared.out).toContain('proj 进行中的事')
})

async function dengniOfAnotherProjectNotThisRepositorys() {
  await nawaban('create', 'O1', '--title', '别的项目', '--project', 'other')
  await nawaban('claim', 'O1')
  await nawaban('event', await idOf('O1'), '--kind', 'note', '--body', 'triage: needs-info — 等你：别处', '--as', AS)
}

it('shows what waits on the decision-maker under each reply, new items first, then that nothing changed', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  expect(await inbox('s1')).toBe('待决 0 件')
  expect(await inbox('s1')).toBeNull()
  await nawaban('claim', 'K1')
  await nawaban('event', await idOf('K1'), '--kind', 'note', '--body', 'triage: needs-info — 等你：给密钥', '--as', AS)
  await dengniOfAnotherProjectNotThisRepositorys()

  const first = await inbox('s1')
  expect(first).toBe('待决 1 件：K1 要密钥｜说「同步」看待决')
  expect(await inbox('s1')).toBe('待决 1 件（无变化）')
  expect(await inbox('s1', { ROLE: 'worker' })).toBeNull()

  const cardWaitsTooOnlyTheNewOneListedToASessionThatSawTheOld = ['--kind', 'ask', '--body', '发不发', '--kr', 'K', '--context', '事实', '--option', '发｜快｜two-way', '--option', '不发｜稳｜two-way', '--rec', '发']
  await nawaban('event', await idOf('K2'), ...cardWaitsTooOnlyTheNewOneListedToASessionThatSawTheOld, '--as', AS)
  expect(await inbox('s1')).toBe('待决 2 件：K2 在干的｜说「同步」看待决')
  expect(await inbox('s2')).toMatch(/^待决 2 件：K\d .* · K\d /)

  const answeredSoNothingWaits = async () => {
    await nawaban('event', await idOf('K1'), '--kind', 'note', '--body', 'triage: ready-for-agent')
    await nawaban('event', await idOf('K2'), '--kind', 'resolve', '--body', '发')
  }
  await answeredSoNothingWaits()
  expect(await inbox('s1')).toBe('待决 0 件')
  expect(await inbox('s1')).toBeNull()

  const viaTheOldWord = await runWithTheHooksEnvironment(['node', CLI, 'inbox', '--project', 'proj'], JSON.stringify({ session_id: 's3' }))
  expect([viaTheOldWord.code, JSON.parse(viaTheOldWord.out).systemMessage, viaTheOldWord.err]).toEqual([0, '待决 0 件', '改用：nawaban status --line --project proj\n'])
})

it('puts a ticket its holder waits on into the pending line, and a resolve hands it back to that holder alone', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  await nawaban('create', 'W1', '--title', '等一句话', '--project', 'proj')
  await nawaban('claim', 'W1')
  const id = await idOf('W1')
  expect(await nawaban('event', 'W1', 'wait', '给密钥')).toBe('✓ W1 记下等你，票挂起等决策者答复\n')
  expect((await team.thread(id)).message.task).toMatchObject({ state: 'blocked', claim: null, blocked: { kind: 'needs_input', reason: '给密钥' } })
  expect(await inbox('w1')).toMatch(/^待决 \d+ 件：.*W1 等一句话/)

  expect(await nawaban('event', 'W1', 'resolve', '给了，在 1Password')).toBe(`✓ W1 记下已决，挂起已解除，指回 ${AS}\n`)
  expect((await team.thread(id)).message.task).toMatchObject({ state: 'ready', blocked: null, for: expect.stringMatching(new RegExp(`\\+${AS}$`)) })
  expect(await inbox('w1')).not.toMatch(/W1/)
  const another = await runWithTheHooksEnvironment(['node', CLI, 'claim', 'W1'], '', { CLAUDE_CODE_SESSION_ID: 'bbbb2222-0000' })
  expect(another.code).toBe(1)
  expect(another.err).toContain('assigned to another profile')
  await nawaban('claim', 'W1')
  await nawaban('claim', 'W1', '--release')
})

it('stays silent when the board is down', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  expect(await inbox('s1', { BOARD_URL: 'http://127.0.0.1:9/api/board' })).toBeNull()
})

it('lets a session outside Herdr that the owner declared read what the web page wrote, and act on it', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const noHerdr = { HC_TERMINAL_ID: '' }
  const stop = (session: string) => inbox(session, noHerdr)
  const prompt = (text: string) => hook('page-writes.sh', { session_id: SESSION, cwd: repo, prompt: text }, noHerdr)
  expect(await stop(SESSION)).toBeNull()

  const declared = await hook('orchestrator-declare.sh', { session_id: SESSION, cwd: repo, prompt: '/nawaban:orchestrator' }, noHerdr)
  expect(declared.out).toContain(`已把会话 ${SESSION} 记为 proj 的编排者`)
  expect(declared.out).toContain('proj 进行中的事')
  expect(declared.out).not.toContain('声明失败')
  const freshBoard = join(tmp, 'fresh-board')
  await mkdir(freshBoard)
  await writeFile(join(freshBoard, 'repos.json'), JSON.stringify({ other: '/elsewhere' }))
  await hook('orchestrator-declare.sh', { session_id: SESSION, cwd: repo, prompt: '/nawaban:orchestrator' }, { ...noHerdr, NAWABAN_BOARD_DIR: freshBoard })
  const registered = JSON.parse(await readFile(join(freshBoard, 'repos.json'), 'utf8'))
  expect(registered.other).toBe('/elsewhere')
  expect(await realpath(registered.proj)).toBe(await realpath(repo))
  expect((await hook('leader-index.sh', { session_id: SESSION }, noHerdr)).out).toContain('proj 进行中的事')
  expect((await hook('leader-index.sh', { session_id: 'someone-else' }, noHerdr)).out).toBe('')
  expect(await stop('someone-else')).toBeNull()
  expect(await stop(SESSION)).toBe('待决 0 件')

  await nawaban('create', 'P1', '--title', '发不发', '--project', 'proj')
  const p1 = await idOf('P1')
  const card = ['--kind', 'ask', '--body', '发不发', '--kr', 'K', '--context', '事实', '--option', '发｜快｜two-way', '--option', '不发｜稳｜two-way', '--rec', '发']
  await nawaban('event', p1, ...card, '--as', AS)
  expect(await stop(SESSION)).toBe('待决 1 件：P1 发不发｜说「同步」看待决')
  expect((await prompt('继续')).out).toBe('')

  await team.reply(p1, { text: webAnswerText({ option: '发', words: '发吧，周五前' }) })
  expect((await team.thread(p1)).message.task?.blocked?.kind).toBe('awaiting_approval')
  expect(await stop(SESSION)).toBe('待决 1 件，网页已答 1 件：P1 发不发（网页已答）｜说「同步」看待决')
  expect(await stop(SESSION)).toBe('待决 1 件，网页已答 1 件（无变化）')
  expect((await prompt('继续')).out).toContain('- P1 发不发：选「发」，发吧，周五前')

  const item = await team.post(inboxChannel('proj'), { text: inboxItemText('面板加夜间模式'), labels: INBOX_OPEN })
  expect(await stop(SESSION)).toBe('待决 1 件，网页已答 1 件：P1 发不发（网页已答）；收件箱 1 条｜说「同步」看待决')
  const context = (await prompt('同步')).out
  expect(context).toContain(`- ${item.id} 面板加夜间模式`)
  expect(await nawaban('status', '--project', 'proj')).toContain(`- ${item.id} 面板加夜间模式`)

  await nawaban('event', p1, '--kind', 'resolve', '--body', '发吧，周五前')
  await nawaban('create', 'IN1', '--title', '面板加夜间模式', '--inbox', item.id)
  expect(await stop(SESSION)).toBe('待决 0 件')
  expect((await prompt('继续')).out).toBe('')
  expect(await nawaban('status', '--project', 'proj')).toContain('- IN1 面板加夜间模式')

  await team.tasks.block(p1, '发不发', { kind: 'awaiting_approval' })
  expect(await stop(SESSION)).toBe('待决 1 件：P1 发不发｜说「同步」看待决')
  await team.tasks.unblock(p1)
  await nawaban('event', p1, ...card, '--as', AS)
  const anAnswerToTheLastCardIsNoAnswerToThisOne = await stop(SESSION)
  expect(anAnswerToTheLastCardIsNoAnswerToThisOne).toBe('待决 1 件（无变化）')
  await nawaban('event', p1, '--kind', 'resolve', '--body', '不发')
})

it('gives the orchestrator what the web page wrote in full once per session, then one line until something new arrives', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const noHerdr = { HC_TERMINAL_ID: '' }
  const prompt = async (session: string) => (await hook('page-writes.sh', { session_id: session, cwd: repo, prompt: '继续' }, noHerdr)).out
  const S = SESSION
  await hook('orchestrator-declare.sh', { session_id: S, cwd: repo, prompt: '/nawaban:orchestrator' }, noHerdr)
  await nawaban('create', 'Q1', '--title', '上不上', '--project', 'proj')
  const q1 = await idOf('Q1')
  await nawaban('event', q1, '--kind', 'ask', '--body', '上不上', '--kr', 'K', '--context', '事实', '--option', '上｜快｜two-way', '--option', '不上｜稳｜two-way', '--rec', '上', '--as', AS)
  const longWords = '先上灰度，'.repeat(80)
  await team.reply(q1, { text: webAnswerText({ option: '上', words: longWords }) })
  const item = await team.post(inboxChannel('proj'), { text: inboxItemText('导出 CSV'), labels: INBOX_OPEN })

  const turns = [await prompt(S), await prompt(S), await prompt(S), await prompt(S), await prompt(S)]
  const full = turns[0]!
  expect(full).toContain(longWords)
  expect(full).toContain(`- ${item.id} 导出 CSV`)
  for (const later of turns.slice(1)) {
    expect(later).not.toContain(longWords)
    expect(later).toContain('上次已给过全文，还开着')
    expect(later).toContain(`Q1`)
    expect(later).toContain(item.id)
  }
  console.log(`page-writes 5 轮注入字数：改前 ${[...full].length * 5}（每轮 ${[...full].length}），改后 ${turns.map((t) => [...t].length).join('+')} = ${turns.reduce((n, t) => n + [...t].length, 0)}`)

  expect(await nawaban('status', '--project', 'proj')).toContain(full.trimEnd())
  const fresh = 'cccc3333-0000-0000-0000-000000000000'
  const oldPage = await runWithTheHooksEnvironment(['node', CLI, 'page', '--project', 'proj', '--session', fresh])
  expect([oldPage.code, oldPage.out, oldPage.err]).toEqual([0, full, `改用：nawaban status --project proj --unseen ${fresh}\n`])

  const second = await team.post(inboxChannel('proj'), { text: inboxItemText('加暗色主题'), labels: INBOX_OPEN })
  const afterNew = await prompt(S)
  expect(afterNew).toContain(`- ${second.id} 加暗色主题`)
  expect(afterNew).not.toContain(longWords)

  await writeFile(join(tmp, 'board', 'page', `shown-${S}.json`), '{')
  expect(await prompt(S)).toContain(longWords)

  const S2 = 'bbbb2222-0000-0000-0000-000000000000'
  await hook('orchestrator-declare.sh', { session_id: S2, cwd: repo, prompt: '/nawaban:orchestrator' }, noHerdr)
  expect(await prompt(S2)).toContain(longWords)

  await nawaban('event', q1, '--kind', 'resolve', '--body', '上')
  for (const m of [item, second]) await nawaban('board', 'label', m.id, 'inbox=done', '--if', 'inbox=open')
  expect(await prompt(S2)).toBe('')
})

it('runs one impact guard per repository: the board\'s where the project moved, the old one elsewhere', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const call = (command: string) => ({ cwd: repo, tool_input: { command } })
  const close = call('vb tasks complete 5')
  const merge = call('gh pr merge 7')
  const log = () => readFile(join(tmp, 'gh.log'), 'utf8').catch(() => '')

  const boardClose = await hook('board-impact-guard.sh', close)
  expect([boardClose.code, boardClose.err]).toEqual([2, expect.stringContaining('nawaban close')])
  expect(boardClose.err).not.toContain('改用')
  expect((await hook('impact-guard.sh', merge)).code).toBe(0)
  const oldGuardNeverAskedGitHub = await log()
  expect(oldGuardNeverAskedGitHub).toBe('')
  const tabReachingHookJsonAsBackslashTStillAMerge = await hook('board-impact-guard.sh', call('gh pr\tmerge 7'))
  expect([tabReachingHookJsonAsBackslashTStillAMerge.code, tabReachingHookJsonAsBackslashTStillAMerge.err]).toEqual([2, expect.stringContaining('核不了 KR 影响声明')])

  const old = { NAWABAN_CLI: 'old' }
  expect((await hook('board-impact-guard.sh', close, old)).code).toBe(0)
  const oldMerge = await hook('impact-guard.sh', merge, old)
  expect([oldMerge.code, oldMerge.err]).toEqual([2, expect.stringContaining('核不了 KR 影响声明')])
  expect(await log()).toContain('pr view 7')
})

it('keeps a worker running while its terminal holds a claimed task, and lets it go once released or when the board is down', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const hcKnowingT1AsTheWorkerInThisRepository = join(tmp, 'worker-bin')
  await mkdir(hcKnowingT1AsTheWorkerInThisRepository)
  await writeFile(join(hcKnowingT1AsTheWorkerInThisRepository, 'hc'), `#!/bin/sh\n[ "$2" = w-r1 ] && echo '{"address":"t1","cwd":"${repo}"}' || exit 3\n`)
  await chmod(join(hcKnowingT1AsTheWorkerInThisRepository, 'hc'), 0o755)
  const worker = { PATH: `${hcKnowingT1AsTheWorkerInThisRepository}:${env.PATH}` }
  const kill = (target: string) => ({ cwd: repo, tool_input: { command: `hc kill ${target}` } })
  await nawaban('create', 'R1', '--title', '收之前要交还', '--project', 'proj')
  await nawaban('claim', 'R1')

  const held = await hook('retire-guard.sh', kill('w-r1'), worker)
  expect([held.code, held.err]).toEqual([2, expect.stringContaining('终端 t1 还拿着 R1')])
  expect((await hook('retire-guard.sh', kill('w-other'), worker)).code).toBe(0)
  const boardDown = await hook('retire-guard.sh', kill('w-r1'), { ...worker, BOARD_URL: 'http://127.0.0.1:9/api/board' })
  expect([boardDown.code, JSON.parse(boardDown.out).systemMessage]).toEqual([0, expect.stringContaining('放行')])

  await nawaban('claim', 'R1', '--release')
  const released = await hook('retire-guard.sh', kill('w-r1'), worker)
  expect([released.code, released.out]).toEqual([0, ''])
})

it('moves a worker\'s task only forward along its milestones and stamps when it last moved, at most once in five minutes, and forgets it on close', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const labelsOf = async (id: string) => (await team.thread(id, { limit: 1 })).message.labels
  const liveOf = async (id: string, until: (live: { milestone: string; at: number }) => boolean = () => true) => {
    for (let tries = 0; tries < 100; tries++) {
      const labels = await labelsOf(id)
      const live = labels.progress ? { milestone: labels.progress, at: Number(labels['progress.at']) } : null
      if (live && until(live)) return live
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }
  await writeFile(join(tmp, 'board/token'), SECRET)
  const transcript = join(tmp, 'transcript.jsonl')
  const called = (input: unknown) => writeFile(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input }] } }) + '\n')
  const afterATool = { session_id: SESSION, cwd: repo, transcript_path: transcript, hook_event_name: 'PostToolUse' }
  const stamp = join(tmp, 'board/progress-stamps', SESSION)
  const gapPassed = () => utimes(stamp, Date.now() / 1000 - 6 * 60, Date.now() / 1000 - 6 * 60)
  await nawaban('create', 'LP1', '--title', '接上进展', '--project', 'proj')
  await nawaban('claim', 'LP1')
  const id = await idOf('LP1')

  await called({ command: 'git commit -m x' })
  expect((await hook('progress.sh', afterATool)).out).toBe('')
  const first = (await liveOf(id))!
  expect(first.milestone).toBe('committed')

  await called({ command: 'gh pr create --fill' })
  await hook('progress.sh', afterATool)
  await new Promise((r) => setTimeout(r, 1500))
  expect((await liveOf(id))!.milestone).toBe('committed')

  await gapPassed()
  await called({ command: 'ls' })
  await hook('progress.sh', afterATool)
  const later = await liveOf(id, (live) => live.at > first.at || live.milestone !== 'committed')
  expect(later?.milestone ?? 'not rewritten').toBe('committed')

  const board = JSON.parse(await nawaban('json', 'board', '--project', 'proj'))
  const row = board.columns.flatMap((c: { tasks: { id: string }[] }) => c.tasks).find((t: { id: string }) => t.id === 'LP1')
  expect(row.live.milestone).toBe('committed')
  expect(await readFile(join(tmp, 'board/progress', `${id}.json`)).catch(() => 'no file')).toBe('no file')

  await nawaban('close', 'LP1', '--cancelled')
  const afterClose = await labelsOf(id)
  expect([afterClose.progress, afterClose['progress.at']]).toEqual([undefined, undefined])
})

it('registers the renewal on every prompt and tool call, and both impact guards before Bash', EVERY_STEP_STARTS_A_NODE_OR_A_SHELL, async () => {
  const { hooks } = JSON.parse(await readFile(join(PLUGIN_HOOKS_RUN_AS_CLAUDE_CODE_RUNS_THEM, 'hooks.json'), 'utf8'))
  const names = (event: string) => hooks[event].flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command.split('/').pop()!.replace('"', '')))
  expect(names('UserPromptSubmit')).toContain('renew.sh')
  expect(names('PostToolUse')).toContain('renew.sh')
  expect(names('PostToolUse')).toContain('progress.sh')
  expect(names('PreToolUse')).toEqual(expect.arrayContaining(['impact-guard.sh', 'board-impact-guard.sh']))
})
