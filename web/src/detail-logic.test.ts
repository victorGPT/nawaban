import { describe, expect, it } from 'vitest'
import { daysUpTo, detailView, type Detail, type Event } from './detail-logic'
import type { BoardTask } from './logic'

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime() / 1000
const NOW = at(24, 18)
const ev = (kind: string, body: string, when: number, author = 'victor'): Event => ({ kind, body, author, at: when })
const detail = (events: Event[], over: Partial<Detail> = {}): Detail => ({
  id: 'T', title: 'T', body: '', status: 'in_progress', project: 'p', session: null, created_at: at(20, 9),
  parent: null, children: [], blocked_by: [], dependents: [], latest_note: null, decisions: [], links: events.filter((e) => e.kind === 'link'), events: [...events].reverse(), ...over,
})
const task = (over: Partial<BoardTask> = {}): BoardTask => ({ id: 'T', title: 'T', status: 'in_progress', parent: null, session: 'cc-1', active_at: NOW - 60, claimed_at: NOW - 600, ...over })
const lines = (view: ReturnType<typeof detailView>) => view.days.map((d) => [d.label, d.rows.map((r) => r.kind + ' ' + r.line)])

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
      ['11/22 周日', ['milestone 派工 w-1']],
    ])
  })

  it('folds two or more progress notes between two nodes into one row, and leaves a lone one as is', () => {
    const view = detailView(detail([
      ev('note', '进展：一', at(24, 9)),
      ev('note', '进展：二\n细节', at(24, 10)),
      ev('decision', '决定：定了', at(24, 11)),
      ev('note', '进展：三', at(24, 12)),
    ]), task(), NOW)
    expect(lines(view)).toEqual([['今天', ['note 三', 'decision 定了', 'notes 二']]])
    expect(view.days[0]!.rows[2]).toEqual({ kind: 'notes', at: at(24, 10), line: '二', notes: [{ at: at(24, 10), line: '二', full: '二\n细节' }, { at: at(24, 9), line: '一', full: '一' }] })
  })

  it('reads a decision as its verdict line, its question, and who made it', () => {
    const view = detailView(detail([
      ev('decision', '决定：只做里程碑\n背景：怎么报进度\n否决方案：每轮摘要', at(24, 9), 'user'),
      ev('decision', '决定：代定的\n影响：无', at(24, 10)),
    ]), task(), NOW)
    const [agent, owner] = view.days[0]!.rows
    expect(owner).toMatchObject({ kind: 'decision', line: '只做里程碑', question: '怎么报进度', by: 'owner', full: '只做里程碑\n背景：怎么报进度\n否决方案：每轮摘要' })
    expect(agent).toMatchObject({ kind: 'decision', line: '代定的', question: null, by: 'agent' })
    expect(view.ruling).toMatchObject({ line: '代定的', by: 'agent', at: at(24, 10) })
  })

  it('reads a needs-info triage note as the question being asked', () => {
    const view = detailView(detail([ev('note', 'triage: needs-info — 等你：这个方向对不对', at(24, 9))]), task({ waiting: '这个方向对不对' }), NOW)
    expect(view.days[0]!.rows[0]).toMatchObject({ kind: 'ask', line: '这个方向对不对' })
    expect(view.waiting).toBe('这个方向对不对')
    expect(view.state).toBe('stopped')
  })

  it('turns a pr link into a milestone and keeps every link in the side list', () => {
    const view = detailView(detail([
      ev('link', 'pr:https://github.com/o/r/pull/136', at(24, 9)),
      ev('link', 'commit:d33f79cd735b522d9556da5c45cb3003f0d9651e', at(24, 10)),
      ev('link', 'artifact:https://claude.ai/artifact/X', at(24, 11)),
    ]), task(), NOW)
    expect(view.days[0]!.rows).toEqual([{ kind: 'milestone', at: at(24, 9), line: '开 PR #136', href: 'https://github.com/o/r/pull/136', mark: 'pr' }])
    expect(view.links.map(({ label, href }) => ({ label, href }))).toEqual([
      { label: 'PR #136', href: 'https://github.com/o/r/pull/136' },
      { label: 'd33f79c', href: null },
      { label: 'artifact', href: 'https://claude.ai/artifact/X' },
    ])
  })

  it('ends a finished task with a 完成 milestone at its done time', () => {
    const view = detailView(detail([ev('note', '进展：收尾', at(24, 9))], { status: 'done' }), task({ status: 'done', done_at: at(24, 10) }), NOW)
    expect(lines(view)).toEqual([['今天', ['milestone 完成', 'note 收尾']]])
    expect(view.state).toBe('done')
    expect(view.steps).toBeNull()
  })

  it('keeps 完成 in time order when something is recorded after the task was done', () => {
    const view = detailView(detail([ev('link', 'commit:abc1234def', at(24, 9)), ev('note', '进展：补一句', at(24, 11))], { status: 'done' }), task({ status: 'done', done_at: at(23, 20) }), NOW)
    expect(lines(view)).toEqual([['今天', ['note 补一句']], ['昨天', ['milestone 完成']]])
  })

  it('shows twenty rows and counts the rest', () => {
    const many = Array.from({ length: 25 }, (_, i) => ev('decision', '决定：' + i, at(10 + (i % 5), 9, i)))
    const { days, hidden } = daysUpTo(detailView(detail(many), task(), NOW).days, 20)
    expect(days.reduce((n, d) => n + d.rows.length, 0)).toBe(20)
    expect(hidden).toBe(5)
  })
})

describe('detailView now', () => {
  it('marks the reached milestone as current and the earlier ones as done', () => {
    const view = detailView(detail([]), task({ live: { milestone: 'pr', at: NOW - 30 } }), NOW)
    expect(view.steps!.map((s) => s.word + ':' + s.status)).toEqual([
      '开工:completed', '首次改文件:completed', '首次提交:completed', '开 PR:in_progress', 'review:pending', '回报:pending',
    ])
    expect(view.headline).toEqual(['开 PR'])
    expect(detailView(detail([]), task({ live: { milestone: 'pr', at: NOW - 360 } }), NOW).headline).toEqual(['开 PR · 6 分钟前'])
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
