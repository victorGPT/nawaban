import { describe, expect, it } from 'vitest'
import { linkOf, projectShown, routeOf, STOPPED_AFTER_SILENT_FOR, summaryOf, taskGroups, taskHref, taskSections, type Board, type BoardTask } from './logic'

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
    expect(g).toEqual({ group: 'stopped', items: [{ key: 'task:S', id: 'S', title: 'S', state: 'stopped', at: NOW - 2 * STOPPED_AFTER_SILENT_FOR, note: '卡在 CI', spec: { done: 1, total: 3 } }] })
  })
  it('lists a spec done once every ticket is done', () => {
    const groups = taskGroups(boardOf(task('S'), task('S-1', { parent: 'S', status: 'done', done_at: NOW - 9 })), NOW)
    expect(groups).toEqual([{ group: 'done', items: [expect.objectContaining({ id: 'S', state: 'done', at: NOW - 9 })] }])
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

describe('header', () => {
  it('summarises the groups', () => {
    expect(summaryOf(taskGroups(boardOf(working('a'), task('b')), NOW), 2)).toBe('待决 2 · 进行中 1 · 停滞 0 · 待办 1')
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
