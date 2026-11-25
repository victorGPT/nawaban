import { describe, expect, it } from 'vitest'
import { adviceOf, ALL_PROJECTS, choicesOf, costOf, inScope, waitedFor, workerOf, preselected, projectChoices, REPLIES, waitingItems, type Card, type ProjectReading, type WaitingBoard } from './decide-logic'

const TELEGRAM: Card = {
  decision: '要不要开一个肉包官方 Telegram 号，把 Telegram 登录的 bot 转到这个号名下',
  kr: 'O3 邀请率 ≥15%',
  context: '- 登录用的 bot 现在挂在个人号下',
  rec: 'A：登录链路不该绑在个人号上，转移不影响线上，Client ID 不变。\n## 选 A 之后要做的\n1. 准备公司手机号',
  options: [
    { key: '第 1 项', text: 'A 开官方号（用公司手机号注册），把 bot 转过去，岳不同保留管理员。', note: '要一个公司手机号；可撤回' },
    { key: '第 2 项', text: 'B 维持现状，bot 留在岳不同个人号下。', note: '0 成本；单点风险在个人号' },
  ],
}
const ADR: Card = {
  decision: '#1800 出结果后：ADR 和图怎么处置',
  kr: '无（开发框架，不挂 KR）',
  context: '3 张票 × 每组 4 次 opus',
  rec: '选第一个（c）：数据说明读文档换不来代码正确，所以不该在开工前花钱读',
  options: [
    { key: '第 1 项', text: '保留 ADR，规矩改成 c：动之前不必读', note: '省掉大部分读文档的成本｜双向门' },
    { key: '第 2 项', text: '只留锚点 b：每个 PR 只跑 check:diagrams --fix', note: '成本最低｜双向门' },
    { key: '第 3 项', text: 'ADR 全删，只留 docs/diagrams 的图', note: '对写代码的 agent 测不出损失｜单向门（删了要从 git 找回）' },
  ],
}

describe('choicesOf', () => {
  it('reads the letter the option starts with, else gives one by position, and drops the closing stop', () => {
    expect(choicesOf(TELEGRAM.options).map((c) => [c.letter, c.text])).toEqual([
      ['A', '开官方号（用公司手机号注册），把 bot 转过去，岳不同保留管理员'],
      ['B', '维持现状，bot 留在岳不同个人号下'],
    ])
    expect(choicesOf(ADR.options).map((c) => c.letter)).toEqual(['A', 'B', 'C'])
  })
  it('keeps the cost, names a one-way door in Chinese, drops a bare two-way door, and sends the option as written', () => {
    const choices = choicesOf([...ADR.options, { key: '第 4 项', text: '撤', note: '快｜one-way' }])
    expect(choices.map((c) => [c.cost, c.oneWay])).toEqual([
      ['省掉大部分读文档的成本', false],
      ['成本最低', false],
      ['对写代码的 agent 测不出损失；单向门（删了要从 git 找回）', true],
      ['快；单向门', true],
    ])
    expect(choices[0]!.sent).toBe(ADR.options[0]!.text)
  })
})

describe('adviceOf', () => {
  it('maps a recommendation to its option by letter or by Chinese ordinal, keeping the reason', () => {
    expect(adviceOf(TELEGRAM.rec, choicesOf(TELEGRAM.options))).toEqual({ choice: 0, why: '登录链路不该绑在个人号上，转移不影响线上，Client ID 不变。' })
    expect(adviceOf(ADR.rec, choicesOf(ADR.options))).toEqual({ choice: 0, why: '数据说明读文档换不来代码正确，所以不该在开工前花钱读' })
    expect(adviceOf('选第 2 项，便宜', choicesOf(ADR.options))?.choice).toBe(1)
  })
  it('keeps the reason but maps to no option when the recommendation names none or names two', () => {
    expect(adviceOf('先放一放', choicesOf(ADR.options))).toEqual({ choice: -1, why: '先放一放' })
    expect(adviceOf('选 A，也就是第二个', choicesOf(ADR.options))?.choice).toBe(-1)
  })
})

const NOW = 1_800_000_000
const board = (...tasks: WaitingBoard['columns'][number]['tasks']): WaitingBoard => ({ columns: [{ key: 'open', tasks }] })
const open = (id: string, over = {}) => ({ id, title: id + ' 的标题', status: 'open', ...over })
const project = (name: string, b: WaitingBoard | null, over: Partial<ProjectReading> = {}): ProjectReading => ({ name, board: b, okr: null, asked: {}, ...over })

describe('waitingItems', () => {
  it('lists held cards and held questions, merging a held child into its held parent', () => {
    const items = waitingItems([
      project('p', board(
        open('PARENT', { waiting: '拆法行不行' }),
        open('CHILD', { parent: 'PARENT', waiting: '先看上级票' }),
        open('CARD', { pending: { at: NOW - 60, card: TELEGRAM, ask: 'ask-1' } }),
        open('PLAIN'),
        open('OLD', { status: 'done', waiting: '早就答了' }),
      ), { asked: { PARENT: [{ kind: 'note', body: '等你：拆法行不行', at: NOW - 600 }, { kind: 'note', body: '进展：…', at: NOW - 30 }] } }),
    ])
    expect(items.map((i) => [i.id, i.kind, i.question, i.since, i.ask])).toEqual([
      ['PARENT', 'ask', '拆法行不行', NOW - 600, '拆法行不行'],
      ['CARD', 'card', TELEGRAM.decision, NOW - 60, 'ask-1'],
    ])
    expect(items[0]!.waitsOnThis).toEqual([{ id: 'CHILD', title: 'CHILD 的标题', state: '等你' }])
  })
  it('counts the tickets a hold blocks, downstream through blocked_by and its open children', () => {
    const [first] = waitingItems([project('p', board(open('Q', { waiting: '要不要' }), open('B1', { blocked_by: ['Q'] }), open('B2', { blocked_by: ['B1'] }), open('K', { parent: 'Q', session: 'w' })))])
    expect(first!.blocks).toBe(3)
    expect(first!.waitsOnThis.map((t) => [t.id, t.state])).toEqual([['B1', '待办'], ['B2', '待办'], ['K', '进行中']])
  })
  it('sorts by tickets blocked, then KRs, then a card first, then the longest wait', () => {
    const items = waitingItems([
      project('a', board(
        open('NEW-ASK', { waiting: '新的' }),
        open('OLD-ASK', { waiting: '老的' }),
        open('CARD', { pending: { at: NOW - 10, card: ADR, ask: 'c' } }),
        open('BLOCKER', { waiting: '挡人的' }),
        open('BLOCKED', { blocked_by: ['BLOCKER'] }),
      ), { asked: { 'NEW-ASK': [{ kind: 'note', body: '等你：新的', at: NOW - 5 }], 'OLD-ASK': [{ kind: 'note', body: 'triage: needs-info — 等你：老的', at: NOW - 500 }] } }),
      project('b', null, { okr: { objectives: [], attention: [{ kind: 'wait', objective: 'O1', kr: 'K1', text: '等你批' }, { kind: 'wait', objective: 'O1', kr: 'K2', text: '等你批' }] } }),
    ])
    expect(items.map((i) => i.id)).toEqual(['BLOCKER', 'O「O1」', 'CARD', 'OLD-ASK', 'NEW-ASK'])
  })
  it('makes one item per shared OKR wait, with each KR reading and no way to answer it on the board', () => {
    const [okr] = waitingItems([project('r', null, { okr: {
      objectives: [{ name: 'O1', krs: [{ name: 'K1', value: 12, unit: '%', target: '>= 15' }, { name: 'K2', value: null, unit: '个百分点', target: '<= 3' }] }],
      attention: [{ kind: 'wait', objective: 'O1', kr: 'K1', text: '等日期定' }, { kind: 'wait', objective: 'O1', kr: 'K2', text: '等日期定' }, { kind: 'stuck', objective: 'O1', kr: 'K1', text: '不算' }],
    } })])
    expect(okr).toMatchObject({ kind: 'okr', krs: 2, ask: null, question: '等日期定', readings: [{ name: 'K1', reading: '12% / 目标 ≥ 15%' }, { name: 'K2', reading: '没读数 / 目标 ≤ 3 个百分点' }] })
  })
  it('gives a held question on a GitHub board no way to answer, and an unfinished card its card id', () => {
    const items = waitingItems([project('gh', { tracker: 'github', columns: [{ key: 'open', tasks: [open('#1', { waiting: '问一句' }), open('#2', { pending: { at: NOW, card: null, ask: 'c2', brief: '待决：先补卡\n更多' } })] }] })])
    expect(items.map((i) => [i.id, i.kind, i.question, i.ask])).toEqual([['#2', 'ask', '待决：先补卡', 'c2'], ['#1', 'ask', '问一句', null]])
  })
})

describe('preselected', () => {
  it('preselects the recommended option unless it is a one-way door', () => {
    const [telegram] = waitingItems([project('r', board(open('T', { pending: { at: NOW, card: TELEGRAM, ask: 'a' } })))])
    expect(preselected(telegram!)).toBe('A')
    const [adr] = waitingItems([project('r', board(open('D', { pending: { at: NOW, card: { ...ADR, rec: '选第三个：删' }, ask: 'a' } })))])
    expect(preselected(adr!)).toBe('')
  })
})

describe('the project picker', () => {
  it('offers every project, and on 待决 all of them first', () => {
    expect(projectChoices(['nawaban', 'roubao'], true)).toEqual([ALL_PROJECTS, 'nawaban', 'roubao'])
    expect(projectChoices(['nawaban', 'roubao'], false)).toEqual(['nawaban', 'roubao'])
  })
  it('narrows the list to the picked project, or keeps all', () => {
    const items = waitingItems([project('a', board(open('A1', { waiting: 'x' }))), project('b', board(open('B1', { waiting: 'y' })))])
    expect(inScope(items, ALL_PROJECTS).map((i) => i.id)).toEqual(['A1', 'B1'])
    expect(inScope(items, 'b').map((i) => i.id)).toEqual(['B1'])
  })
})

describe('the list line', () => {
  it('says how long a hold has waited in minutes, hours or days', () => {
    expect(waitedFor(NOW - 5 * 60, NOW)).toBe('5 分钟')
    expect(waitedFor(NOW - 3 * 3600, NOW)).toBe('3 小时')
    expect(waitedFor(NOW - 2 * 86400, NOW)).toBe('2 天')
    expect(waitedFor(null, NOW)).toBe('')
  })
  it('names the cost of waiting by tickets blocked first, then KRs', () => {
    expect(costOf({ blocks: 3, krs: 2 })).toBe('挡着 3 张票')
    expect(costOf({ blocks: 0, krs: 2 })).toBe('2 条 KR 量不了')
    expect(costOf({ blocks: 0, krs: 0 })).toBe('')
  })
  it('reads who works on a ticket from its latest dispatch', () => {
    const events = [
      { kind: 'dispatch', body: '{"worker":"old","agent":"codex","model":"gpt"}', at: 1 },
      { kind: 'note', body: '进展', at: 3 },
      { kind: 'dispatch', body: '{"worker":"home-a","agent":"claude","model":"opus"}', at: 2 },
    ]
    expect(workerOf(events)).toEqual({ name: 'home-a', agent: 'claude', model: 'opus' })
    expect(workerOf([{ kind: 'dispatch', body: 'not json', at: 1 }])).toBeNull()
    expect(workerOf([])).toBeNull()
  })
})

it('answers with an option or words only, never a resolve', () => {
  expect(REPLIES.pick('发')).toEqual({ option: '发', words: '就这么定' })
  expect(Object.keys(REPLIES.unclear)).toEqual(['words'])
  expect(REPLIES.say('下周一')).toEqual({ words: '下周一' })
})
