import { expect, it } from 'vitest'
import { indexText } from '../src/orchestrator.ts'

process.env.TZ = 'UTC'
const NOW = 10_000_000
const HOUR = 3600
const task = (id: string, title: string, at: number, more: object = {}) => ({
  id, title, status: 'open', parent: null, session: null, created_at: at, active_at: at, claimed_at: null,
  progress: null, waiting: null, decision: null, ...more,
})
const born = NOW - 40 * HOUR
const decisionOvertakingTheNextStep = { at: NOW - HOUR / 2, verdict: '先不接 CLI' }

const OLD_CLIS_INDEX_GOLDEN_FROM_THE_SAME_JSON_BOARD_DATA = `p 进行中的事 · 04-26 17:46 生成
等你 1 · Stale 1 · WIP 1 · Backlog 2

## 等你
- W 等用户
  下一步：选 A 还是 B？

## Stale
- S 卡住的（26 小时没动静 · 停在：@alice）
  进展 26 小时前：跑到一半 @alice 在看

## WIP
- C1 子任务 · 属于 SPEC 总规格
  进展 1 小时前：写完测试
  最近决定 30 分钟前：先不接 CLI

## 48 小时内你的 Decision Record 1（agent 自己定的另有 1 条，在各任务里）
- 3 小时前 D 发布

## Backlog 2（开着，从没认领也没写进展）
- TRI 分诊过的
- IDLE 没人碰

48 小时内关了 1 个。`

it('groups the open work into 等你, Stale and WIP, then the Decision Records, the Backlog and the closed', () => {
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
  expect(indexText(data, 'p', NOW)).toBe(OLD_CLIS_INDEX_GOLDEN_FROM_THE_SAME_JSON_BOARD_DATA)
})

it('counts a done task with no time of its own as not recently closed', () => {
  const data = { columns: [{ key: 'done', tasks: [task('OLD', '老任务', 0, { status: 'done', done_at: null })] }] }
  expect(indexText(data, 'p', NOW).endsWith('48 小时内关了 0 个。')).toBe(true)
})

it('ends a link before the CJK text after it', () => {
  const body = '详见 https://github.com/o/r/pull/300（PR #300 的评论）'
  const data = { columns: [{ key: 'in_progress', tasks: [task('L', '带链接', NOW, { session: 'l', progress: { body, at: NOW } })] }] }
  expect(indexText(data, 'p', NOW)).toContain('进展 0 分钟前：详见 (链接)（PR #300 的评论）')
})

it('reads a status update written as Done / Next / Blockers: progress is what is done, the next step stops before Blockers', () => {
  const body = 'Done: 写完测试 / Next: 接 CLI / Blockers: 无'
  const data = { columns: [{ key: 'in_progress', tasks: [task('T', '三段', NOW, { session: 't', claimed_at: NOW, progress: { body, at: NOW } })] }] }
  expect(indexText(data, 'p', NOW)).toContain('- T 三段\n  进展 0 分钟前：写完测试\n  下一步：接 CLI\n')
})
