import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { lastSentence, lastWords } from '../src/progress.ts'

const transcriptOf = async (...steps: unknown[]) => {
  const path = join(await mkdtemp(join(tmpdir(), 'nawaban-progress-')), 't.jsonl')
  await writeFile(path, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return path
}

it('reads the last words of a Claude Code, a Codex and an Antigravity transcript alike', async () => {
  const claude = await transcriptOf(
    { type: 'assistant', message: { content: [{ type: 'text', text: '先读票。' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  )
  const codex = await transcriptOf({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '补测试。' }] } })
  const agy = await transcriptOf({ type: 'PLANNER_RESPONSE', content: '改面板。' }, { type: 'RUN_COMMAND', content: 'ls' })
  expect([await lastWords(claude), await lastWords(codex), await lastWords(agy)]).toEqual(['先读票。', '补测试。', '改面板。'])
})

it('falls back to what the last tool call said it does, when a turn writes no text', async () => {
  const quiet = await transcriptOf({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'REPL', input: { code: '…', description: 'Run the board tests' } }] } })
  expect(lastWords(quiet)).toBe('Run the board tests')
  expect(lastWords(undefined)).toBeNull()
  expect(lastWords('/nowhere/at/all.jsonl')).toBeNull()
})

it('keeps the last sentence, plain and short', () => {
  expect(lastSentence('**改完了**。下一步跑 `pnpm check`！')).toBe('下一步跑 pnpm check！')
  expect(lastSentence('one\n\n```sh\nrm -rf x\n```')).toBe('one')
  expect([...lastSentence('长'.repeat(200))!].length).toBe(81)
  expect(lastSentence('')).toBeNull()
})
