import { describe, expect, it } from 'vitest'
import fixture from '../../herdr/mods/nawaban-board/okr.fixture.json'
import { boardColumns, cardSignal, DONE_SHOWN_ON_BOARD, krFill, okrReadingOfFailure, okrView, OKR_WORDS, linkOf, projectShown, routeOf, STOPPED_AFTER_SILENT_FOR, summaryOf, waitingOnYouCount, taskGroups, taskHref, taskSections, type Board, type BoardTask } from './logic'

const NOW = 1_800_000_000
const task = (id: string, over: Partial<BoardTask> = {}): BoardTask => ({
  id, title: id, status: 'open', parent: null, session: null, active_at: NOW - 60, claimed_at: null, ...over,
})
const boardOf = (...tasks: BoardTask[]): Board => ({ columns: [{ key: 'open', tasks }], decisions: [] })
const working = (id: string, over: Partial<BoardTask> = {}) => task(id, { status: 'in_progress', session: 'w', claimed_at: NOW - 600, ...over })

describe('routeOf', () => {
  it('takes the token out and keeps the route beside it', () => {
    expect(routeOf('#k=abc')).toEqual({ route: { tab: 'tasks', task: null }, token: 'abc', hashWithoutToken: '' })
    expect(routeOf('#okr&k=abc')).toEqual({ route: { tab: 'okr', task: null }, token: 'abc', hashWithoutToken: '#okr' })
  })
  it('opens a task by its key, even one with # or spaces', () => {
    expect(routeOf(taskHref('#389')).route).toEqual({ tab: 'tasks', task: '#389' })
    expect(routeOf(taskHref('NAWABAN-WEB-06')).route).toEqual({ tab: 'tasks', task: 'NAWABAN-WEB-06' })
  })
  it('falls back to 任务 on anything it does not know', () => {
    expect(routeOf('#nope').route.tab).toBe('tasks')
    expect(routeOf('#task-%E0').route).toEqual({ tab: 'tasks', task: null })
    expect(routeOf('#inbox').route.tab).toBe('inbox')
  })
})

describe('taskGroups', () => {
  it('reads a held task silent past the limit as stopped, a recent one as working, an asking one as stopped', () => {
    const groups = taskGroups(boardOf(
      working('A'),
      working('B', { active_at: NOW - STOPPED_AFTER_SILENT_FOR - 1 }),
      task('C', { waiting: '要你定' }),
      task('D'),
      task('E', { status: 'done', done_at: NOW - 5 }),
    ), NOW)
    expect(groups.map((g) => [g.group, g.items.map((x) => x.id)])).toEqual([
      ['stopped', ['C', 'B']], ['working', ['A']], ['todo', ['D']], ['done', ['E']],
    ])
    expect(groups[0]!.items[0]!.note).toBe('要你定')
  })
  it('folds tickets into their spec, which takes the state of its stopped ticket and counts done ones', () => {
    const [g] = taskGroups(boardOf(
      task('S'),
      task('S-1', { parent: 'S', status: 'done', done_at: NOW - 100 }),
      working('S-2', { parent: 'S', active_at: NOW - 2 * STOPPED_AFTER_SILENT_FOR, progress: { body: '卡在 CI', at: NOW } }),
      working('S-3', { parent: 'S' }),
    ), NOW)
    expect(g).toEqual({ group: 'stopped', items: [{ key: 'task:S', id: 'S', title: 'S', state: 'stopped', at: NOW - 2 * STOPPED_AFTER_SILENT_FOR, note: '卡在 CI', doing: { head: '【在做】S —— 编排者代定', chain: '[开工] → 首次改文件 → 首次提交 · 2 天没动', stale: true }, spec: { done: 1, total: 3 }, waiting: false, parent: null }] })
  })
  it('lists a spec done once every ticket is done', () => {
    const groups = taskGroups(boardOf(task('S'), task('S-1', { parent: 'S', status: 'done', done_at: NOW - 9 })), NOW)
    expect(groups).toEqual([{ group: 'done', items: [expect.objectContaining({ id: 'S', state: 'done', at: NOW - 9 })] }])
  })
  it('lists every issue of a GitHub board on its own, as the panel does', () => {
    const github: Board = { ...boardOf(task('#1'), working('#2', { parent: '#1' })), tracker: 'github' }
    expect(taskGroups(github, NOW).map((g) => [g.group, g.items.map((x) => x.id)])).toEqual([['working', ['#2']], ['todo', ['#1']]])
    const claimedByATerminalOnly = task('#3', { terminal: 't1' })
    expect(taskGroups({ ...boardOf(claimedByATerminalOnly), tracker: 'github' }, NOW)[0]!.group).toBe('working')
    expect(taskGroups(boardOf(claimedByATerminalOnly), NOW)[0]!.group).toBe('todo')
  })
  it('lists a ticket whose parent is not on the board on its own', () => {
    expect(taskGroups(boardOf(task('X', { parent: 'GONE' })), NOW)[0]!.items[0]!.id).toBe('X')
  })
  it('orders by latest activity, done by when it was done', () => {
    const groups = taskGroups(boardOf(task('old', { active_at: NOW - 900 }), task('new'), task('d1', { status: 'done', done_at: 1 }), task('d2', { status: 'done', done_at: 2 })), NOW)
    expect(groups.map((g) => g.items.map((x) => x.id))).toEqual([['new', 'old'], ['d2', 'd1']])
  })
})

describe('taskSections, shared with the Herdr panel', () => {
  const groups = taskGroups(boardOf(...['a', 'b', 'c', 'd', 'e'].map((id) => working(id)), task('t')), NOW)
  it('opens 停滞 and 进行中 by default, shows 3 rows and says how many more', () => {
    const [w, t] = taskSections(groups, { folds: {}, project: 'p', shownAll: {} })
    expect([w.group, w.open, w.count, w.items.length, w.more]).toEqual(['working', true, 5, 3, { hidden: 2 }])
    expect([t.group, t.open, t.more]).toEqual(['todo', false, null])
  })
  it('shows all once asked', () => {
    const [w] = taskSections(groups, { folds: {}, project: 'p', shownAll: { 'p:working': true } })
    expect([w.items.length, w.more]).toEqual([5, { hidden: 0 }])
  })
})

describe('boardColumns', () => {
  it('always shows 待办 进行中 停滞 已完成, in that order, even when empty', () => {
    const cols = boardColumns(taskGroups(boardOf(task('t')), NOW), false)
    expect(cols.map((c) => [c.group, c.count])).toEqual([['todo', 1], ['working', 0], ['stopped', 0], ['done', 0]])
  })
  it('puts the task stopped longest first', () => {
    const silent = (id: string, age: number) => working(id, { active_at: NOW - STOPPED_AFTER_SILENT_FOR - age })
    const cols = boardColumns(taskGroups(boardOf(silent('recent', 1), silent('oldest', 9000), silent('mid', 500)), NOW), false)
    expect(cols[2]!.items.map((x) => x.id)).toEqual(['oldest', 'mid', 'recent'])
  })
  it('shows the latest 10 done and says how many more, until asked for all', () => {
    const done = Array.from({ length: 13 }, (_, n) => task('d' + n, { status: 'done', done_at: n }))
    const groups = taskGroups(boardOf(...done), NOW)
    const capped = boardColumns(groups, false)[3]!
    expect([capped.count, capped.items.length, capped.items[0]!.id, capped.more]).toEqual([13, DONE_SHOWN_ON_BOARD, 'd12', { hidden: 3 }])
    expect(boardColumns(groups, true)[3]!.items.length).toBe(13)
  })
  it('keeps the spec count on the card', () => {
    const cols = boardColumns(taskGroups(boardOf(task('S'), task('S-1', { parent: 'S', status: 'done', done_at: 1 }), task('S-2', { parent: 'S' })), NOW), false)
    expect(cols[0]!.items[0]!.spec).toEqual({ done: 1, total: 2 })
  })
})

describe('the board card', () => {
  const signalOf = (...tasks: BoardTask[]) => cardSignal(taskGroups(boardOf(...tasks), NOW)[0]!.items[0]!, NOW)
  it('says nothing beside the key while the task is todo, working or done', () => {
    expect(signalOf(task('t'))).toBeNull()
    expect(signalOf(working('w', { live: { milestone: 'pr', at: NOW - 60 }, ruling: { at: NOW, verdict: '好' } }))).toBeNull()
    expect(signalOf(task('d', { status: 'done', done_at: NOW - 60 }))).toBeNull()
  })
  it('says how long a stopped task has stopped', () => {
    expect(signalOf(working('s', { active_at: NOW - 5 * 24 * 3600 }))).toBe('停了 5 天')
  })
  it('says 等你, and only that, when the task waits on you, stopped or not', () => {
    expect(signalOf(working('q', { waiting: '要不要接上\n背景……' }))).toBe('等你')
    expect(signalOf(working('q', { waiting: '定吗', active_at: NOW - 5 * 24 * 3600 }))).toBe('等你')
  })
})

describe('the parent beside the key', () => {
  it('names the parent issue of a GitHub issue, and nothing for a task that has none', () => {
    const github: Board = { ...boardOf(task('#1', { title: '分享与邀请' }), task('#2', { parent: '#1' }), task('#3', { parent: '#404' })), tracker: 'github' }
    const parents = Object.fromEntries(taskGroups(github, NOW).flatMap((g) => g.items).map((x) => [x.id, x.parent]))
    expect(parents).toEqual({ '#1': null, '#2': '分享与邀请', '#3': null })
  })
})

describe('header', () => {
  it('counts what closed today, what runs and what waits for you, with no denominator', () => {
    const board = boardOf(working('a'), working('q', { waiting: '定吗' }), task('b'), task('p', { pending: { at: NOW } as BoardTask['pending'] }), task('d', { status: 'done', done_at: NOW - 60 }))
    const running = taskGroups(board, NOW).find((g) => g.group === 'working')!.items.length
    expect([running, waitingOnYouCount(board)]).toEqual([1, 2])
    expect(summaryOf(board, NOW)).toBe('今天关了 1 · 在跑 1 · 等你 2')
  })
  it('a held task reads 在做, with the milestone it reached and how lately it moved', () => {
    const board = boardOf(working('a', { title: '接上进展', live: { milestone: 'pr', at: NOW - 120 } }))
    expect(taskGroups(board, NOW)[0]!.items[0]!.doing).toEqual({ head: '【在做】接上进展 —— 编排者代定', chain: '✓3 步 → [开 PR] → review → 回报 · 2 分钟前还在动', stale: false })
  })
  it('shows the picked project, else the busiest', () => {
    const ps = [{ name: 'a', open: 1, total: 1, waiting: 0 }, { name: 'b', open: 4, total: 9, waiting: 0 }]
    expect(projectShown(ps, 'a')).toBe('a')
    expect(projectShown(ps, 'gone')).toBe('b')
    expect(projectShown([], null)).toBe(null)
  })
})

describe('linkOf', () => {
  it('links only http(s)', () => {
    expect(linkOf('pr:https://github.com/x/y/pull/1')).toEqual({ kind: 'pr', ref: 'https://github.com/x/y/pull/1', href: 'https://github.com/x/y/pull/1' })
    expect(linkOf('doc:javascript:alert(1)').href).toBe(null)
  })
})

describe('OKR, as the Herdr panel reads okr.fixture.json', () => {
  const view = okrView(fixture)!
  const krs = view.objectives.flatMap((o) => [...o.krs, ...o.untestedKrs, ...o.metKrs])
  const kr = (name: string) => krs.find((k) => k.name === name)!
  it('puts an Objective with a red KR first, its unmet KRs before the folded met ones', () => {
    const [first] = view.objectives
    expect(first!.name).toBe('听得懂需求')
    expect(first!.krs.map((k) => k.status)).toEqual(['missed', 'stale'])
    expect(first!.metKrs.length).toBe(2)
    expect(first!.untestedKrs.length).toBe(1)
  })
  it('reads 实际 / 目标 · 偏差 · 灯 · 截至', () => {
    expect(kr('长对话换题多带旧条件')).toMatchObject({ value: '84.6%', target: '≤ 20%', gap: '-64.6 点', status: 'missed', day: '11-19' })
    expect(OKR_WORDS.zh.status.missed).toBe('红')
  })
  it('fills the bar toward the goal only for a target that starts with an operator and a number', () => {
    expect(krFill(kr('长对话换题多带旧条件'))).toBeCloseTo(20 / 84.6)
    expect(krFill(kr('意图准确率'))).toBe(1)
    expect(krFill(kr('误拦率'))).toBe(null)
    expect(krFill({ measured: true, target: '尽量少', value: '3' })).toBe(null)
    expect(krFill({ measured: true, target: '≥ 0', value: '-1' })).toBe(0)
  })
  it('reads a repo without okr.toml as no Objective, and any other refusal as an error', () => {
    expect(okrReadingOfFailure(new Error('没有 docs/agents/okr.toml:KR 定义写在仓库里'))).toEqual({ objectives: [] })
    expect(okrReadingOfFailure(new Error('项目 x 没在 repos.json 登记仓库'))).toBe(null)
  })
})
