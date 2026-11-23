import { expect, it } from 'vitest'
import { answersStillAbout, decisionCards, handedText, REPLIES, type Card, type DecideBoard } from './decide-logic'

const card = (decision: string): Card => ({
  decision,
  kr: 'KR1',
  context: '事实',
  options: [{ key: '第 1 项', text: '发', note: '快｜two-way' }, { key: '第 2 项', text: '不发', note: '稳｜two-way' }],
  rec: '发',
})
const held = (id: string, at: number, c: Card | null, status = 'open') => ({ id, title: id, status, pending: { at, card: c, ask: `${id}@${at}` } })

const board: DecideBoard = {
  columns: [
    { key: 'open', tasks: [held('B', 20, card('后问')), held('NOT-READY', 5, null), { id: 'PLAIN', title: 'PLAIN', status: 'open', pending: null }] },
    { key: 'in_progress', tasks: [held('A', 10, card('先问'))] },
    { key: 'done', tasks: [held('DONE', 1, card('早已结束'), 'done')] },
  ],
}

it('lists only complete cards of open tasks, oldest question first', () => {
  expect(decisionCards(board, []).map((c) => [c.id, c.decision])).toEqual([['A', '先问'], ['B', '后问']])
  expect(decisionCards(null, [])).toEqual([])
})

it('marks a card handed once the board holds a page answer to it', () => {
  const answer = { task: 'B', option: '发', words: '就这么定', at: '2026-11-24T00:00:00Z' }
  const cards = decisionCards(board, [answer, { ...answer, task: 'GONE' }])
  expect(cards.map((c) => c.handed)).toEqual([null, answer])
  expect(handedText(answer)).toBe('已交编排者：选「发」，就这么定')
  expect(handedText({ ...answer, option: null, words: REPLIES.unclear.words })).toBe('已交编排者：背景不够，请补写后重发待决')
})

it('keeps answers read for an earlier board only for cards that did not change since', () => {
  const answer = { task: 'B', option: '发', words: '就这么定', at: '2026-11-24T00:00:00Z' }
  const fetched = { board, answers: [answer] }
  expect(answersStillAbout(board, fetched)).toEqual([answer])
  const sameCards: DecideBoard = { columns: board.columns.map((c) => ({ ...c, tasks: [...c.tasks] })) }
  expect(answersStillAbout(sameCards, fetched)).toEqual([answer])
  const reraisedInTheSameSecond: DecideBoard = { columns: [{ key: 'open', tasks: [{ ...held('B', 20, card('换了一张卡')), pending: { at: 20, card: card('换了一张卡'), ask: 'B-new' } }] }] }
  expect(answersStillAbout(reraisedInTheSameSecond, fetched)).toEqual([])
  expect(answersStillAbout(board, { board: null, answers: [answer] })).toEqual([])
})

it('names the door in Chinese and keeps the rest of the option note as written', () => {
  const doors: DecideBoard = { columns: [{ key: 'open', tasks: [held('D', 1, { ...card('门'), options: [{ key: '第 1 项', text: '发', note: '快｜two-way' }, { key: '第 2 项', text: '撤', note: 'one-way' }, { key: '第 3 项', text: '等', note: '慢' }] })] }] }
  expect(decisionCards(doors, [])[0].options.map((o) => o.note)).toEqual(['快｜双向门', '单向门', '慢'])
})

it('heads the card with the first line of the decision and keeps only the lines after it below', () => {
  const lines: DecideBoard = { columns: [{ key: 'open', tasks: [held('L', 1, card('发不发 v2？\n影响 3 个仓库\n周五前要定')), held('S', 2, card('只有一行'))] }] }
  expect(decisionCards(lines, []).map((c) => [c.headline, c.more])).toEqual([['发不发 v2？', '影响 3 个仓库\n周五前要定'], ['只有一行', '']])
})

it('answers with an option or words only, never a resolve', () => {
  expect(REPLIES.pick('发')).toEqual({ option: '发', words: '就这么定' })
  expect(Object.keys(REPLIES.unclear)).toEqual(['words'])
  expect(Object.keys(REPLIES.decided)).toEqual(['words'])
})
