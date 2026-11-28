import { expect, it } from 'vitest'
import { INDEX_CHARS_AT_MOST, indexText } from '../src/orchestrator.ts'

process.env.TZ = 'UTC'
const NOW = 10_000_000
const HOUR = 3600
const task = (id: string, title: string, at: number, more: object = {}) => ({
  id, title, status: 'open', parent: null, session: null, created_at: at, active_at: at, claimed_at: null,
  progress: null, waiting: null, decision: null, ...more,
})
const born = NOW - 40 * HOUR
const decisionOvertakingTheNextStep = { at: NOW - HOUR / 2, verdict: '先不接 CLI' }

const INDEX_GOLDEN = `p 进行中的事 · 04-26 17:46 生成
等你 1 · 停滞 1 · 进行中 1 · 待办 2

## 等你
- W 等用户
  下一步：选 A 还是 B？

## 停滞
- S 卡住的（26 小时没动静 · 停在：@alice） · 跑到一半 @alice 在看

## 进行中
- C1 子任务 · 属于 SPEC 总规格 · 写完测试

## 你 48 小时内的决定 1
- 3 小时前 D 发布

## 待办 2（没人认领过）
- P2 TRI 分诊过的
- P2 IDLE 没人碰`

it('groups the open work into 等你, 停滞 and 进行中, then the owner decisions and the 待办', () => {
  const data = {
    columns: [
      {
        key: 'open',
        tasks: [
          task('SPEC', '总规格', born),
          task('IDLE', '没人碰', born + 4),
          task('TRI', '分诊过的', born + 5, { progress: { body: 'triage: ready-for-agent', at: born + 5 } }),
        ],
      },
      {
        key: 'in_progress',
        tasks: [
          task('C1', '子任务', born + 1, {
            parent: 'SPEC', session: 'c', claimed_at: NOW - 2 * HOUR, active_at: NOW - HOUR / 2,
            progress: { body: '写完测试，下一步：接 CLI。', at: NOW - HOUR },
            decision: decisionOvertakingTheNextStep,
          }),
          task('W', '等用户', born + 2, {
            session: 'w', claimed_at: NOW - 5 * HOUR, active_at: NOW - 5 * HOUR, waiting: '选 A 还是 B？',
            progress: { body: 'triage: needs-info — 等你：选 A 还是 B？', at: NOW - 5 * HOUR },
          }),
          task('S', '卡住的', born + 3, {
            session: 's', claimed_at: NOW - 30 * HOUR, active_at: NOW - 26 * HOUR,
            progress: { body: '跑到一半 @alice 在看', at: NOW - 26 * HOUR },
          }),
        ],
      },
      { key: 'done', tasks: [task('D', '发布', born + 6, { status: 'done', done_at: NOW - 3 * HOUR })] },
    ],
    decisions: [
      { task: 'C1', at: NOW - HOUR / 2, verdict: '先不接 CLI', owner: false },
      { task: 'D', at: NOW - 3 * HOUR, verdict: '发布', owner: true },
    ],
  }
  expect(indexText(data, 'p', NOW)).toBe(INDEX_GOLDEN)
})

it('ends a link before the CJK text after it', () => {
  const body = '详见 https://github.com/o/r/pull/300（PR #300 的评论）'
  const data = { columns: [{ key: 'in_progress', tasks: [task('L', '带链接', NOW, { session: 'l', progress: { body, at: NOW } })] }] }
  expect(indexText(data, 'p', NOW)).toContain('- L 带链接 · 详见 (链接)（PR #300 的评论）')
})

it.each(['已完成：写完测试 / 下一步：接 CLI / 卡点：无', 'Done: 写完测试 / Next: 接 CLI / Blockers: 无'])('reads a 进展同步 as 已完成 / 下一步 / 卡点, or its English names: %j', (body) => {
  const moving = { columns: [{ key: 'in_progress', tasks: [task('T', '三段', NOW, { session: 't', claimed_at: NOW, progress: { body, at: NOW } })] }] }
  expect(indexText(moving, 'p', NOW)).toContain('- T 三段 · 写完测试')
  const stalled = { columns: [{ key: 'in_progress', tasks: [task('T', '三段', NOW - 30 * HOUR, { session: 't', claimed_at: NOW - 30 * HOUR, progress: { body, at: NOW - 30 * HOUR } })] }] }
  expect(indexText(stalled, 'p', NOW)).toContain('- T 三段（30 小时没动静 · 停在：没写） · 写完测试\n  下一步：接 CLI')
})

const LINES_ABOVE_THE_TASKS = 4

it('gives each task in progress one line, so the index an orchestrator wakes up to grows by one line a task', () => {
  const progress = (body: string) => ({ session: 's', claimed_at: NOW, progress: { body: `${body}，下一步：再看`, at: NOW } })
  const tasks = Array.from({ length: 30 }, (_, i) => task(`M${i}`, `第 ${i} 张`, NOW, progress(`进展 ${i}`)))
  const lines = indexText({ columns: [{ key: 'in_progress', tasks }] }, 'p', NOW).split('\n')
  expect(lines.length).toBeLessThanOrEqual(LINES_ABOVE_THE_TASKS + tasks.length)
})

it('folds tasks whose progress says the same thing into one line', () => {
  const swept = (id: string) => task(id, `标题 ${id}`, NOW, { session: 's', claimed_at: NOW, progress: { body: '扫票判部分做完，不关', at: NOW } })
  const text = indexText({ columns: [{ key: 'in_progress', tasks: ['A', 'B', 'C'].map(swept) }] }, 'p', NOW)
  expect(text).toContain('## 进行中\n- 3 张进展都是「扫票判部分做完，不关」：A B C')
  expect(text.match(/扫票/g)).toHaveLength(1)
})

it('folds only progress that is the same in full, not the same in its first characters', () => {
  const alike = (id: string, tail: string) => task(id, `标题 ${id}`, NOW, { session: 's', claimed_at: NOW, progress: { body: `${'同'.repeat(60)}${tail}`, at: NOW } })
  const text = indexText({ columns: [{ key: 'in_progress', tasks: [alike('A', '甲'), alike('B', '乙')] }] }, 'p', NOW)
  expect(text).not.toContain('2 张进展都是')
  expect(text).toContain('- A 标题 A · ')
})

it('prints nothing for a section with nothing to act on', () => {
  const text = indexText({ columns: [{ key: 'done', tasks: [task('D', '发布', NOW, { status: 'done', done_at: NOW })] }], decisions: [] }, 'p', NOW)
  expect(text).toBe('p 进行中的事 · 04-26 17:46 生成\n等你 0 · 停滞 0 · 进行中 0 · 待办 0')
})

it('lists the 待办 by tier, a ticket blocking a higher one at that tier, and P1s by how far their KR is from its target', () => {
  const idle = [
    task('P2-NEW', '新的 P2', NOW, { priority: 'P2' }),
    task('UNTIERED', '建档前的票', NOW - 1),
    task('GATE', '挡着 P0', NOW - 2, { priority: 'P2' }),
    task('TOP', '线上坏了', NOW - 3, { priority: 'P0', blocked_by: ['GATE'] }),
    task('NEAR', '差一点', NOW - 4, { priority: 'P1', priority_kr: '近的' }),
    task('FAR', '差得远', NOW - 5, { priority: 'P1', priority_kr: '远的' }),
    task('UNREAD', '没读数', NOW - 6, { priority: 'P1', priority_kr: '没读过的' }),
    task('BUG', '小 bug', NOW - 7, { priority: 'P1', priority_kr: '线上可见 bug' }),
  ]
  const gaps = new Map([['近的', 0.05], ['远的', 0.5]])
  const text = indexText({ columns: [{ key: 'open', tasks: idle }] }, 'p', NOW, gaps)
  expect(text.split('## 待办 8（没人认领过）\n')[1]!.split('\n').map((l) => l.split(' ').slice(1, 3).join(' '))).toEqual([
    'P0 GATE', 'P0 TOP', 'P1 UNREAD', 'P1 BUG', 'P1 FAR', 'P1 NEAR', 'P2 P2-NEW', 'P2 UNTIERED',
  ])
})

it('folds the 待办, then the progress, then the titles, until the index fits its character budget', () => {
  const many = (n: number, state: object) => Array.from({ length: n }, (_, i) => task(`K${i}-${Object.keys(state).length}`, `一个相当长的标题，第 ${i} 张，写满三十四个字符好让它截断`, NOW - i, state))
  const moving = many(80, { session: 's', claimed_at: NOW, progress: { body: '各写各的进展，长度也不短，接近四十个字符的样子', at: NOW } })
  const idle = many(60, {})
  const text = indexText({ columns: [{ key: 'open', tasks: idle }, { key: 'in_progress', tasks: moving }] }, 'p', NOW)
  expect([...text].length).toBeLessThanOrEqual(INDEX_CHARS_AT_MOST)
  expect(text).toContain('## 待办 60（没人认领过，跑 nawaban list 看）')
  expect(text).toContain('进行中 80')
})
