import { describe, expect, it } from 'vitest'
import { agentLetter, agentLine, justHappened, pushedThreads, todaysMoves, waitingOnYou } from './home-logic'
import { STOPPED_AFTER_SILENT_FOR, type Agent, type Board, type BoardTask, type Decision } from './logic'
import type { Card } from './decide-logic'

const NOW = new Date(2026, 10, 25, 12).getTime() / 1000
const HOUR = 3600
const DAY = 24 * HOUR
const task = (id: string, over: Partial<BoardTask> = {}): BoardTask => ({
  id, title: id, status: 'open', parent: null, session: null, active_at: NOW - 60, claimed_at: null, ...over,
})
const working = (id: string, over: Partial<BoardTask> = {}) => task(id, { status: 'in_progress', session: 'w', claimed_at: NOW - 600, ...over })
const boardOf = (tasks: BoardTask[], decisions: Decision[] = []): Board => ({ columns: [{ key: 'open', tasks }], decisions })
const codex: Agent = { harness: 'codex', model: 'gpt-5.5', worker: 'w-codex' }
const claude: Agent = { harness: 'claude', model: null, worker: 'w-claude' }
const card: Card = { decision: '发不发\n细节', kr: 'KR1', context: '事实', options: [], rec: '发' }

describe('agent words', () => {
  it('names the harness, then the model and worker it was dispatched with', () => {
    expect(agentLine(codex, 'model')).toBe('Codex · gpt-5.5')
    expect(agentLine(codex, 'model', 'worker')).toBe('Codex · gpt-5.5 · w-codex')
    expect(agentLetter(codex)).toBe('X')
  })
  it('says the harness alone when the dispatch named no model', () => {
    expect(agentLine(claude, 'model')).toBe('Claude Code')
    expect(agentLine({ harness: 'agy', model: null, worker: null }, 'model', 'worker')).toBe('Antigravity')
  })
  it('says 未知 and nothing else when no dispatch named an agent', () => {
    expect(agentLine(null, 'model', 'worker')).toBe('未知')
    expect(agentLetter(null)).toBe('?')
  })
})

describe('waitingOnYou', () => {
  it('lists each open task held on you, oldest first, 要批 for an approval and 问你 for a question', () => {
    const board = boardOf([
      task('LATER', { pending: { at: NOW - 100, card: null, ask: null, brief: '批不批\n长说明' }, waiting: '批不批', agent: claude }),
      task('CARD', { pending: { at: NOW - 300, card, ask: 'm1' }, waiting: '发不发', agent: codex }),
      task('ASKS', { waiting: '放行吗？\n第二行', active_at: NOW - 200 }),
      task('DONE', { status: 'done', waiting: '早问过' }),
      task('PLAIN'),
    ])
    expect(waitingOnYou(board).map((w) => [w.id, w.ask, w.question, w.answerable, w.agent?.harness ?? null])).toEqual([
      ['CARD', 'approve', '发不发', true, 'codex'],
      ['ASKS', 'question', '放行吗？', false, null],
      ['LATER', 'approve', '批不批', false, 'claude'],
    ])
  })
})

describe('pushedThreads', () => {
  it('puts what waits on you first, then what moves by latest activity, then what stopped, each with its word and agent', () => {
    const board = boardOf([
      working('STOPPED', { active_at: NOW - 2 * DAY, progress: { body: '卡在 CI\n日志', at: NOW - 2 * DAY } }),
      working('OLDER', { active_at: NOW - 500, agent: claude }),
      working('NEWER', { active_at: NOW - 5, progress: { body: '测试过了', at: NOW - 5 }, agent: codex }),
      working('BLOCKED', { waiting: '放行吗？', active_at: NOW - 1000 }),
      task('TODO'),
      task('DONE', { status: 'done', done_at: NOW - 10 }),
    ])
    expect(pushedThreads(board, NOW).map((p) => [p.id, p.push, p.word, p.note, p.agent?.worker ?? null])).toEqual([
      ['BLOCKED', 'blocked', '卡在你', '放行吗？', null],
      ['NEWER', 'moving', '在推', '测试过了', 'w-codex'],
      ['OLDER', 'moving', '在推', null, 'w-claude'],
      ['STOPPED', 'idle', '停了 2 天', '卡在 CI', null],
    ])
  })
  it('folds tickets under their spec and takes the agent of the ticket being worked', () => {
    const board = boardOf([task('S'), working('S-1', { parent: 'S', agent: codex }), task('S-2', { parent: 'S' })])
    expect(pushedThreads(board, NOW).map((p) => [p.id, p.agent])).toEqual([['S', codex]])
  })
  it('reads a silence past the limit as stopped', () => {
    const board = boardOf([working('QUIET', { active_at: NOW - STOPPED_AFTER_SILENT_FOR - 1 })])
    expect(pushedThreads(board, NOW)[0]!.push).toBe('idle')
  })
})

describe('todaysMoves', () => {
  it('lists only what closed today and what you decided today, newest first', () => {
    const today = NOW - 2 * HOUR
    const board = boardOf(
      [
        task('CLOSED', { status: 'done', done_at: today }),
        task('YESTERDAY', { status: 'done', done_at: NOW - 13 * HOUR }),
        task('OPEN'),
      ],
      [
        { task: 'MINE', at: today + 60, verdict: '先只读\n第二行', owner: true },
        { task: 'AGENTS', at: today + 120, verdict: '代定', owner: false },
        { task: 'OLD', at: NOW - DAY, verdict: '昨天定的', owner: true },
      ],
    )
    expect(todaysMoves(board, NOW)).toEqual([
      { at: today + 60, task: 'MINE', text: '决定：先只读' },
      { at: today, task: 'CLOSED', text: '完成：CLOSED' },
    ])
  })
})

describe('justHappened', () => {
  it('lists the latest progress and completions across tasks, newest first, each with its agent, at most 8', () => {
    const board = boardOf([
      working('A', { progress: { body: '改完了\n细节', at: NOW - 30 }, agent: codex }),
      task('B', { status: 'done', done_at: NOW - 10, title: '下载按钮', agent: claude }),
      ...Array.from({ length: 9 }, (_, n) => working('OLD' + n, { progress: { body: '旧', at: NOW - 1000 - n } })),
    ])
    const rows = justHappened(board)
    expect(rows.length).toBe(8)
    expect(rows.slice(0, 3)).toEqual([
      { at: NOW - 10, task: 'B', text: '完成：下载按钮', agent: claude },
      { at: NOW - 30, task: 'A', text: '改完了', agent: codex },
      { at: NOW - 1000, task: 'OLD0', text: '旧', agent: null },
    ])
  })
  it('says a question as it was asked, without the triage label before it', () => {
    const board = boardOf([task('Q', { progress: { body: 'triage: needs-info — 等你：要不要接上', at: NOW - 5 } })])
    expect(justHappened(board)[0]!.text).toBe('等你：要不要接上')
  })
})
