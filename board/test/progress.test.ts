import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { milestoneOfCheckout, milestoneOfTranscript } from '../src/progress.ts'

const transcriptOf = async (...steps: unknown[]) => {
  const path = join(await mkdtemp(join(tmpdir(), 'nawaban-progress-')), 't.jsonl')
  await writeFile(path, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return path
}
const claudeCall = (name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } })
const BRIEF_NAMING_THE_REPORT = { type: 'user', message: { content: '完成后 hc send t19p "回报：X 完成 | …"，再 gh pr create' } }

it('takes the furthest milestone a Claude Code session reached, from its tool calls and never from the brief it was given', async () => {
  expect(milestoneOfTranscript(await transcriptOf(BRIEF_NAMING_THE_REPORT, claudeCall('Read', { file_path: 'a.ts' })))).toBe('started')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Edit', { file_path: 'a.ts' }), claudeCall('Read', { file_path: 'b.ts' })))).toBe('edited')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('REPL', { code: "await edit('a.ts', 'x', 'y')" })))).toBe('edited')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'git commit -m x && gh pr create --fill' }), claudeCall('Read', {})))).toBe('pr')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'gh pr checks 9' })))).toBe('review')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'git -C /tmp/x commit -qm x' })))).toBe('committed')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'hc send t19p "回报：X 完成 | ok | PR"' })))).toBe('reported')
})

it('counts only commands it ran, not text it wrote or searched for', async () => {
  const brief = '完成后 hc send t19p "回报：X 完成"，再 gh pr create'
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Write', { file_path: 'brief.md', content: brief })))).toBe('edited')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'rg -n "gh pr create" board/src' })))).toBe('started')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'rg -n "(gh pr create|git commit)" board/src' })))).toBe('started')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: "echo 'x; hc send t1 \"回报：X\"'" })))).toBe('started')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'hc send t19p "x" && echo 回报：' })))).toBe('reported')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('REPL', { code: `const b = ${JSON.stringify(brief)}; await $\`rg -n gh board\`` })))).toBe('started')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('REPL', { code: 'await $`git add -A && git commit -qm x`' })))).toBe('committed')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Agent', { subagent_type: 'codex:codex-rescue', prompt: 'review' })))).toBe('review')
})

it('does not take text a command writes through a heredoc for a command', async () => {
  const command = 'cat > docs/contributing.md <<EOF\n# Submit changes\ngit commit -m fix\ngh pr create --fill\nEOF'
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command })))).toBe('started')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: "cat <<'EOF' > x\nhi\nEOF\ngit commit -qm x" })))).toBe('committed')
})

it('reads a task only from the session\'s last claim of it, so a reused worker\'s next task starts over', async () => {
  const a = { id: '10', key: 'K-A' }
  const b = { id: '11', key: 'K-B' }
  const reusedWorker = await transcriptOf(
    claudeCall('Bash', { command: 'node cli.ts claim K-A' }),
    claudeCall('Bash', { command: 'gh pr create --fill' }),
    claudeCall('Bash', { command: 'hc send t19p "回报：K-A 完成"' }),
    claudeCall('Bash', { command: 'node cli.ts claim K-B' }),
    claudeCall('Edit', { file_path: 'b.ts' }),
  )
  expect(milestoneOfTranscript(reusedWorker, b)).toBe('edited')
  expect(milestoneOfTranscript(reusedWorker, a)).toBe('reported')
})

it('reads Codex and Antigravity tool calls the same way', async () => {
  const codex = await transcriptOf({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git commit -m x"}' } })
  const agy = await transcriptOf({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'gh pr create --fill' } }] }, { type: 'USER_INPUT', content: 'hc send t1 "回报：…"' })
  expect([milestoneOfTranscript(codex), milestoneOfTranscript(agy)]).toEqual(['committed', 'pr'])
  expect(milestoneOfTranscript(undefined)).toBe('started')
  expect(milestoneOfTranscript('/nowhere/at/all.jsonl')).toBe('started')
})

it('reads the checkout: changed files, then commits past origin/main', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-checkout-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect(await milestoneOfCheckout(dir)).toBe('started')
  await writeFile(join(dir, 'a.txt'), 'x')
  expect(await milestoneOfCheckout(dir)).toBe('edited')
  git('add', '.')
  git('commit', '-q', '-m', 'x')
  expect(await milestoneOfCheckout(dir)).toBe('committed')
  expect(await milestoneOfCheckout(join(dir, 'missing'))).toBe('started')
})
