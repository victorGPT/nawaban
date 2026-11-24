import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { narrationOf, type Hold } from '../src/narrate.ts'
import { taskDetail } from '../src/views.ts'

const T0 = Date.parse('2026-11-24T15:00:00Z') / 1000
const SESSION = 'aaaa1111-2222-4333-8444-555566667777'
const WORKER = 'cc-aaaa1111'
const CWD = '/repo'
const iso = (s: number) => new Date((T0 + s) * 1000).toISOString()
const said = (s: number, text: string, stop_reason = 'tool_use') => ({ type: 'assistant', timestamp: iso(s), cwd: CWD, message: { id: `m${s}`, stop_reason, content: [{ type: 'text', text }] } })
const thought = (s: number) => ({ type: 'assistant', timestamp: iso(s), cwd: CWD, message: { id: `m${s}`, stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '想一想' }] } })
const called = (s: number, name: string, input: unknown, more: Record<string, unknown> = {}) => ({ type: 'assistant', timestamp: iso(s), cwd: CWD, ...more, message: { stop_reason: 'stop_sequence', content: [{ type: 'tool_use', name, input }] } })
const edited = (s: number, file_path: string) => called(s, 'Edit', { file_path })
const ran = (s: number, command: string) => called(s, 'Bash', { command })
const held = (from: number, to: number | null, by = WORKER): Hold => ({ by, from: T0 + from, to: to === null ? null : T0 + to })
const rows = (narration: Awaited<ReturnType<typeof narrationOf>>) => narration.map((r) => `${r.at - T0} ${r.kind} ${r.text}`)

async function claudeTranscript(...steps: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), 'nawaban-narrate-'))
  await mkdir(join(home, 'projects', '-repo'), { recursive: true })
  await writeFile(join(home, 'projects', '-repo', `${SESSION}.jsonl`), steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  vi.stubEnv('CLAUDE_CONFIG_DIR', home)
}

afterEach(() => vi.unstubAllEnvs())

it('lists only what happened while this task was held, when one session worked two tasks in turn', async () => {
  await claudeTranscript(said(10, '先读票'), edited(20, '/repo/a.ts'), edited(99, '/repo/b.ts'), edited(101, '/repo/c.ts'), said(110, '接下一张'))
  const first = held(0, 100)
  const next = held(100, null)
  expect(rows(await narrationOf([first], T0 + 200))).toEqual(['10 said 先读票', '20 edited a.ts, b.ts'])
  expect(rows(await narrationOf([next], T0 + 200))).toEqual(['101 edited c.ts', '110 said 接下一张'])
})

it('lists every stretch a task was held and nothing from the gap between them', async () => {
  await claudeTranscript(said(10, '第一段'), said(60, '挂起时'), said(130, '第二段'), said(300, '还开着'))
  expect(rows(await narrationOf([held(0, 50), held(120, null)], T0 + 200))).toEqual(['10 said 第一段', '130 said 第二段'])
})

it('takes what the worker said between tool calls, never its thinking or its final reply, as plain text', async () => {
  const sidechain = { ...said(40, '子代理说的'), isSidechain: true }
  await claudeTranscript(thought(5), said(10, '先 `读` **票**\n\n  再改  '), said(20, '做完了', 'end_turn'), sidechain)
  expect(rows(await narrationOf([held(0, null)], T0 + 100))).toEqual(['10 said 先 读 票\n再改'])
})

it('counts only test and build commands it ran, not ones it searched for or wrote out', async () => {
  await claudeTranscript(
    ran(10, 'rg -n "pnpm test" board/src'),
    ran(20, "cat > notes.md <<'EOF'\nrun pnpm test first\nEOF"),
    ran(30, 'cd board && pnpm check'),
  )
  expect(rows(await narrationOf([held(0, null)], T0 + 100))).toEqual(['30 tested 在跑测试 / 检查'])
})

it('folds a run of edits into one row per run, each file once, and starts over after the worker speaks', async () => {
  await claudeTranscript(
    edited(10, '/repo/a.ts'),
    edited(11, '/repo/a.ts'),
    edited(12, '/repo/web/b.ts'),
    ran(14, 'pnpm test'),
    edited(15, '/repo/a.ts'),
    said(16, '改第二轮'),
    edited(17, 'a.ts'),
  )
  expect(rows(await narrationOf([held(0, null)], T0 + 100))).toEqual(['10 edited a.ts, web/b.ts', '14 tested 在跑测试 / 检查', '16 said 改第二轮', '17 edited a.ts'])
})

it('says a test is running at most once in 15 seconds', async () => {
  await claudeTranscript(ran(0, 'pnpm test'), ran(10, 'pnpm test'), ran(15, 'npx vitest run'), ran(29, 'pnpm build'), ran(31, 'cargo test'))
  expect(rows(await narrationOf([held(0, null)], T0 + 100)).map((r) => r.split(' ')[0])).toEqual(['0', '15', '31'])
})

it('reads a code-mode session from the calls its script made, not again from the script', async () => {
  const script = called(10, 'REPL', { code: "await edit('/repo/a.ts', 'x', 'y'); await $`pnpm test`" }, { madeBy: 'model' })
  await claudeTranscript(script, { ...edited(11, '/repo/a.ts'), madeBy: 'other', isVirtual: true }, { ...ran(11, 'pnpm test'), madeBy: 'other', isVirtual: true })
  expect(rows(await narrationOf([held(0, null)], T0 + 100))).toEqual(['11 edited a.ts', '11 tested 在跑测试 / 检查'])
})

it('reads a Codex session found by the start of its thread id, and nothing when two threads share it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nawaban-codex-'))
  const day = join(home, 'sessions', '2026', '11', '24')
  await mkdir(day, { recursive: true })
  const thread = '01a1fe42-52d8-70e2-814a-5c85e262ca3b'
  const steps = [
    { timestamp: iso(1), type: 'turn_context', payload: { cwd: CWD } },
    { timestamp: iso(10), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '先跑测试' }] } },
    { timestamp: iso(11), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'await tools.exec_command({cmd: "pnpm test"})' } },
    { timestamp: iso(12), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'pnpm test'] } } },
    { timestamp: iso(13), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: { '/repo/src/a.ts': { type: 'update' } } } } },
    { timestamp: iso(14), type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '完成' }] } },
  ]
  await writeFile(join(day, `rollout-2026-11-24T15-00-00-${thread}.jsonl`), steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  vi.stubEnv('CODEX_HOME', home)
  const codex = [held(0, null, 'cx-01a1fe42')]
  expect(rows(await narrationOf(codex, T0 + 100))).toEqual(['10 said 先跑测试', '12 tested 在跑测试 / 检查', '13 edited src/a.ts'])
  await writeFile(join(day, 'rollout-2026-11-24T15-00-30-01a1fe42-963f-7020-984a-a8c7d6cee6df.jsonl'), '')
  expect(await narrationOf(codex, T0 + 100)).toEqual([])
})

it('has nothing to say for a session whose transcript is not on this machine', async () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', await mkdtemp(join(tmpdir(), 'nawaban-empty-')))
  expect(await narrationOf([held(0, null), held(0, null, 'agy-12345678'), held(0, null, 'victor')], T0 + 100)).toEqual([])
})

it('names an edited file from the checkout the session started in, wherever the shell stood, and leaves out files outside it', async () => {
  const fromASubfolder = { ...edited(20, 'src/main.tsx'), cwd: '/repo/web' }
  await claudeTranscript(edited(10, '/repo/web/src/logic.ts'), fromASubfolder, edited(30, '/tmp/scratch/shot.mjs'), said(40, '截图'), edited(50, '/tmp/scratch/page.html'))
  expect(rows(await narrationOf([held(0, null)], T0 + 100))).toEqual(['10 edited web/src/logic.ts, web/src/main.tsx', '40 said 截图'])
})

it('stops at the moment the task is put on hold for the owner, since a hold ends the claim with no release', async () => {
  await claudeTranscript(said(105, '还拿着'), said(120, '挂起后在做别的票'))
  const message = { id: '1', channel: 'nawaban', createdAt: iso(0), text: 'A', labels: { key: 'A' }, blocks: [], task: { state: 'blocked', needs: [], blocked: { kind: 'needs_input', reason: '等你' } } }
  const feed = [['task.claimed', 100], ['task.blocked', 110]].map(([type, s]) => ({ type, createdAt: iso(s as number), payload: { id: '1', by: { actor: `victor+${WORKER}` } } }))
  const team = { tasks: { list: async () => ({ tasks: [{ message }] }) }, poll: async ({ after }: { after: string }) => ({ cursor: 'end', events: after === 'end' ? [] : feed }) }
  const detail = await taskDetail(team as unknown as Parameters<typeof taskDetail>[0], 'A')
  expect(rows(detail.narration)).toEqual(['105 said 还拿着'])
})
