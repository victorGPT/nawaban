import { describe, expect, it } from 'vitest'
import { detailView, type Detail, type Event } from './detail-logic'
import type { BoardTask } from './logic'

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime() / 1000
const NOW = at(24, 18)
const ev = (kind: string, body: string, when: number, author = 'victor'): Event => ({ kind, body, author, at: when })
const detail = (events: Event[], over: Partial<Detail> = {}): Detail => ({
  id: 'T', title: 'T', body: '', status: 'in_progress', project: 'p', session: null, created_at: at(20, 9),
  parent: null, children: [], blocked_by: [], dependents: [], latest_note: null, decisions: [], links: events.filter((e) => e.kind === 'link'), events: [...events].reverse(), ...over,
})
const task = (over: Partial<BoardTask> = {}): BoardTask => ({ id: 'T', title: 'T', status: 'in_progress', parent: null, session: 'cc-1', active_at: NOW - 60, claimed_at: NOW - 600, ...over })
const lines = (view: ReturnType<typeof detailView>) => view.timeline.everything.map((d) => [d.label, d.rows.map((r) => r.kind + ' ' + r.line)])

describe('detailView timeline', () => {
  it('groups rows by local day, newest day and newest row on top', () => {
    const view = detailView(detail([
      ev('dispatch', '{"worker":"w-1","terminal":"t1"}', at(22, 9)),
      ev('decision', '决定：上\n背景：做不做', at(23, 10), 'user'),
      ev('note', '进展：开工', at(24, 9)),
      ev('decision', '决定：用里程碑', at(24, 11)),
    ]), task(), NOW)
    expect(lines(view)).toEqual([
      ['今天', ['decision 用里程碑', 'note 开工']],
      ['昨天', ['decision 上']],
      ['11/22 周日', ['dispatch 派工 w-1 t1']],
    ])
  })

  it('keeps only the decision-maker\'s rulings and what was asked of them up front, with everything one step away', () => {
    const view = detailView(detail([
      ev('dispatch', '{"worker":"w-1","terminal":"t1"}', at(24, 8)),
      ev('note', '进展：一', at(24, 9)),
      ev('note', 'triage: needs-info — 等你：行不行', at(24, 10)),
      ev('decision', '决定：行', at(24, 11), 'user'),
      ev('decision', '决定：代定的', at(24, 12)),
      ev('link', 'pr:https://github.com/o/r/pull/136', at(24, 13)),
    ]), task(), NOW)
    expect(view.timeline.forTheOwner.map((d) => [d.label, d.rows.map((r) => r.kind + ' ' + r.line)])).toEqual([['今天', ['decision 行', 'ask 行不行']]])
    expect(lines(view)).toEqual([['今天', ['decision 代定的', 'decision 行', 'ask 行不行', 'note 一', 'dispatch 派工 w-1 t1']]])
    expect(view.timeline.total).toBe(5)
  })

  it('reads a decision as its verdict line, its question, and who made it', () => {
    const view = detailView(detail([
      ev('decision', '决定：只做里程碑\n背景：怎么报进度\n否决方案：每轮摘要', at(24, 9), 'user'),
      ev('decision', '决定：代定的\n影响：无', at(24, 10)),
    ]), task(), NOW)
    const [agent, owner] = view.timeline.everything[0]!.rows
    expect(owner).toMatchObject({ kind: 'decision', line: '只做里程碑', question: '怎么报进度', by: 'owner', full: '只做里程碑\n背景：怎么报进度\n否决方案：每轮摘要' })
    expect(agent).toMatchObject({ kind: 'decision', line: '代定的', question: null, by: 'agent' })
    expect(view.ruling).toMatchObject({ line: '代定的', by: 'agent', at: at(24, 10) })
  })

  it('reads a needs-info triage note as the question being asked', () => {
    const view = detailView(detail([ev('note', 'triage: needs-info — 等你：这个方向对不对', at(24, 9))]), task({ waiting: '这个方向对不对' }), NOW)
    expect(view.timeline.everything[0]!.rows[0]).toMatchObject({ kind: 'ask', line: '这个方向对不对' })
    expect(view.waiting).toBe('这个方向对不对')
    expect(view.state).toBe('stopped')
  })

  it('keeps links out of the timeline and lists every one at the side', () => {
    const view = detailView(detail([
      ev('link', 'pr:https://github.com/o/r/pull/136', at(24, 9)),
      ev('link', 'commit:d33f79cd735b522d9556da5c45cb3003f0d9651e', at(24, 10)),
      ev('link', 'artifact:https://claude.ai/artifact/X', at(24, 11)),
    ]), task(), NOW)
    expect(view.timeline.total).toBe(0)
    expect(view.facts.outputs).toEqual([
      { label: 'PR #136', note: null, href: 'https://github.com/o/r/pull/136' },
      { label: '提交 d33f79c', note: null, href: null },
      { label: '设计稿', note: null, href: 'https://claude.ai/artifact/X' },
    ])
  })

  it('names whoever holds the task by the worker it was dispatched to, with its terminal, never by the session id', () => {
    const dispatched = detailView(detail([ev('dispatch', '{"worker":"w-old"}', at(24, 8)), ev('dispatch', '{"worker":"w-new"}', at(24, 9))]), task({ terminal: 't1j6' }), NOW)
    expect(dispatched.facts.holder).toEqual({ name: 'w-new', terminal: 't1j6' })
    expect([dispatched.facts.dispatchedAt, detailView(detail([]), task(), NOW).facts.dispatchedAt]).toEqual([at(24, 9), null])
    expect(detailView(detail([]), task({ terminal: 't1j6' }), NOW).facts.holder).toEqual({ name: 't1j6', terminal: null })
    expect(detailView(detail([]), task({ status: 'open', session: null }), NOW).facts.holder).toBeNull()
    expect(detailView(detail([]), task({ session: 'cc-1234', terminal: null }), NOW).facts.holder).toBeNull()
  })

  it('opens a dispatch onto what counts as done', () => {
    const [row] = detailView(detail([ev('dispatch', '{"worker":"w-1","terminal":"t1","accept":"测试全过"}', at(24, 9))]), task(), NOW).timeline.everything[0]!.rows
    expect(row).toMatchObject({ kind: 'dispatch', line: '派工 w-1 t1', full: '派工 w-1 t1\n验收：测试全过' })
  })
})

describe('detailView now', () => {
  it('marks the reached milestone as current and the earlier ones as done', () => {
    const view = detailView(detail([]), task({ live: { milestone: 'pr', at: NOW - 30 } }), NOW)
    expect(view.steps!.map((s) => s.word + ':' + s.status)).toEqual([
      '开工:completed', '首次改文件:completed', '首次提交:completed', '开 PR:in_progress', 'review:pending', '回报:pending',
    ])
    expect([view.headline, view.stepLine]).toEqual([[], '开 PR'])
    expect(detailView(detail([]), task({ live: { milestone: 'pr', at: NOW - 360 } }), NOW).stepLine).toBe('开 PR · 6 分钟前')
    expect(detailView(detail([]), task({ waiting: '行不行', live: { milestone: 'edited', at: NOW - 360 } }), NOW)).toMatchObject({ headline: ['行不行'], stepLine: '首次改文件 · 6 分钟前' })
  })

  it('starts at 开工 with no live milestone, and shows no steps for a task off the board', () => {
    expect(detailView(detail([]), task(), NOW).steps![0]).toEqual({ word: '开工', status: 'in_progress' })
    const offBoard = detailView(detail([], { status: 'done' }), null, NOW)
    expect([offBoard.state, offBoard.steps, offBoard.headline]).toEqual(['done', null, ['已完成']])
  })

  it('says what it waits for first, with the place a link leads to as the link', () => {
    const view = detailView(detail([]), task({ waiting: '稿可不可以（https://claude.ai/artifact/abc）\n第二行' }), NOW)
    expect(view.headline).toEqual(['稿可不可以（', { label: 'claude.ai', href: 'https://claude.ai/artifact/abc' }, '）'])
  })

  it('says a finished task is done, when, and by which pull request', () => {
    const pr = ev('link', 'pr:https://github.com/o/r/pull/136', at(24, 15))
    const view = detailView(detail([pr], { status: 'done' }), task({ status: 'done', done_at: at(24, 16, 37) }), NOW)
    expect(view.headline).toEqual(['已完成 · 11/24 16:37', ' · ', { label: 'PR #136', href: 'https://github.com/o/r/pull/136' }])
  })

  it('says a held task that went quiet has stopped, and nothing for one nobody holds', () => {
    expect(detailView(detail([]), task({ active_at: NOW - 30 * 3600 }), NOW).headline).toEqual(['停滞 · 1 天没动'])
    expect(detailView(detail([]), task({ status: 'open', session: null }), NOW).headline).toEqual([])
  })
})

describe('detailView body', () => {
  it('cuts the body at its ## headings and names the known ones in Chinese', () => {
    const view = detailView(detail([], { body: '前言一句\n## What to build\n做这个\n## Acceptance criteria\n- 过测试\n## 备注\n\n## Other\n其它' }), task(), NOW)
    expect(view.sections.map((s) => s.label)).toEqual([null, '做什么', '完成标准', 'Other'])
    expect(view.sections[2]!.html).toContain('<li>过测试</li>')
  })
})

describe('detailView one-liners', () => {
  it('drops who and when from the decision-maker\'s line, since the row already shows them', () => {
    const view = detailView(detail([
      ev('decision', '决定：决策者 11-24 14:28「挺好的」，照做\n背景：做不做', at(24, 9), 'user'),
      ev('decision', '决定：决策者 11-24 授权，编排者代定', at(24, 10)),
    ]), task(), NOW)
    expect(lines(view)).toEqual([['今天', ['decision 决策者 11-24 授权，编排者代定', 'decision 「挺好的」，照做']]])
  })

  it('names the place a URL leads to instead of spelling it out, in rows and in what it waits for', () => {
    const asked = '稿可不可以（https://claude.ai/artifact/abc）'
    const view = detailView(detail([
      ev('note', '进展：PR https://github.com/o/r/pull/136（ff93bb1）开了', at(24, 9)),
      ev('note', 'triage: needs-info — 等你：' + asked, at(24, 10)),
    ]), task({ waiting: asked }), NOW)
    expect(lines(view)).toEqual([['今天', ['ask 稿可不可以（claude.ai）', 'note PR PR #136（ff93bb1）开了']]])
    expect(view.waiting).toBe('稿可不可以（claude.ai）')
  })

  it('leaves lane and coord bookkeeping out of the timeline', () => {
    const view = detailView(detail([ev('note', 'lane: design', at(24, 9)), ev('note', 'coord: x', at(24, 10)), ev('note', '进展：一', at(24, 11))]), task(), NOW)
    expect(lines(view)).toEqual([['今天', ['note 一']]])
  })
})

describe('detailView first lines', () => {
  it('carries on into the next line when the first only opens what follows', () => {
    const view = detailView(detail([ev('decision', '决定：模拟后修正：\n\n里程碑只往前走\n背景：怎么改', at(24, 9))]), task(), NOW)
    expect(lines(view)).toEqual([['今天', ['decision 模拟后修正：里程碑只往前走']]])
    expect(lines(detailView(detail([ev('decision', '决定：格式：\n背景：写什么', at(24, 9))]), task(), NOW))).toEqual([['今天', ['decision 格式：']]])
  })

  it('opens the decision-maker\'s row onto the same words it showed closed', () => {
    const [row] = detailView(detail([ev('decision', '决定：决策者 11-24：只收完成回报\n背景：发给谁', at(24, 9), 'user')]), task(), NOW).timeline.everything[0]!.rows
    expect(row).toMatchObject({ line: '只收完成回报', full: '只收完成回报\n背景：发给谁' })
  })
})

describe('detailView decision cards', () => {
  it('shows a decision card as what was asked and the answer as the decision-maker\'s ruling', () => {
    const card = JSON.stringify({ decision: '用 A 还是 B', kr: '无', context: '两种都能做', options: [{ choice: 'A', tradeoff: '快', door: 'two-way' }, { choice: 'B', tradeoff: '稳', door: 'one-way' }], recommendation: 'A' })
    const view = detailView(detail([ev('ask', card, at(24, 9)), ev('resolve', JSON.stringify({ words: '就 A' }), at(24, 10))]), task(), NOW)
    expect(lines(view)).toEqual([['今天', ['decision 就 A', 'ask 用 A 还是 B']]])
    expect(view.timeline.everything[0]!.rows[1]).toMatchObject({ full: '用 A 还是 B\n两种都能做\nA｜快\nB｜稳\n建议：A' })
    expect(view.ruling).toMatchObject({ line: '就 A', by: 'owner' })
  })
})

describe('detailView facts', () => {
  it('says one word for the state, 等你 over 卡住 when it waits for the decision-maker, 取消 for a cancelled task', () => {
    const word = (over: Partial<BoardTask>, status = 'in_progress') => detailView(detail([], { status }), task(over), NOW).facts.stateWord
    expect([word({}), word({ waiting: '行不行' }), word({ active_at: NOW - 30 * 3600 }), word({ status: 'done', done_at: NOW }), word({ status: 'open', session: null })]).toEqual(['进行中', '等你', '卡住', '完成', '待办'])
    expect(detailView(detail([], { status: 'cancelled' }), null, NOW).facts).toMatchObject({ stateWord: '取消', cancelled: true })
  })

  it('reads the lane, the goal it serves, and only the blockers still open', () => {
    const impact = JSON.stringify({ objective: '决策者少被打断', krs: [{ name: '回报一行', dir: '=' }, { name: '等你准确', dir: '↑', before: '0', after: '1', basis: '预计' }] })
    const facts = detailView(detail([ev('note', 'lane: design', at(24, 8)), ev('impact', impact, at(24, 9))], {
      blocked_by: [{ id: 'A', title: 'a', status: 'done' }, { id: 'B', title: 'b', status: 'open' }],
    }), task(), NOW).facts
    expect(facts).toMatchObject({ lane: 'design', goal: '决策者少被打断 / 回报一行、等你准确', blockedBy: [{ id: 'B' }] })
    expect(detailView(detail([ev('impact', JSON.stringify({ objective: '无', krs: [] }), at(24, 9))]), task(), NOW).facts.goal).toBeNull()
  })

  it('marks a pull request merged once the task records it, and lists it once', () => {
    const facts = detailView(detail([ev('link', 'pr:https://github.com/o/r/pull/124', at(24, 9)), ev('link', 'pr:https://github.com/o/r/pull/124 merged 61175c7', at(24, 10)), ev('link', 'adr:docs/adr/0003-web-page.md', at(24, 11))]), task(), NOW).facts
    expect(facts.outputs).toEqual([{ label: 'PR #124', note: '已合并', href: 'https://github.com/o/r/pull/124' }, { label: 'ADR 0003', note: null, href: null }])
  })

  it('says how long a held task has been going and how long a finished one took', () => {
    expect(detailView(detail([]), task({ claimed_at: NOW - 2 * 3600 }), NOW).facts.took).toBe('开工至今 2 小时')
    expect(detailView(detail([], { status: 'done' }), task({ status: 'done', claimed_at: NOW - 3 * 3600, done_at: NOW - 3600 }), NOW).facts.took).toBe('用时 2 小时')
    expect(detailView(detail([]), task({ status: 'open', session: null, claimed_at: null }), NOW).facts.took).toBeNull()
  })
})
