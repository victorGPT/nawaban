import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { githubIssuesHeldBy, milestoneOfCheckout, milestoneOfTranscript, recordProgress } from '../src/progress.ts'

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
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'node /Users/x/.nawaban/plugin/board/src/cli.ts tell X "完成 PR #5"' })))).toBe('reported')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: 'cd wt && nawaban tell X "受阻，详情在票上"' })))).toBe('reported')
  expect(milestoneOfTranscript(await transcriptOf(claudeCall('Bash', { command: "rg -n 'nawaban tell' board/src" })))).toBe('started')
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

it('reads a task only from when the session claimed it, so a reused worker\'s next task starts over', async () => {
  const at = (iso: string, step: Record<string, unknown>) => ({ ...step, timestamp: iso })
  const reusedWorker = await transcriptOf(
    at('2026-11-24T05:00:00Z', claudeCall('Bash', { command: 'gh pr create --fill' })),
    at('2026-11-24T05:10:00Z', claudeCall('Bash', { command: 'hc send t19p "回报：K-A 完成"' })),
    at('2026-11-24T05:21:00Z', claudeCall('Edit', { file_path: 'b.ts' })),
  )
  const claimedB = Date.parse('2026-11-24T05:20:00Z') / 1000
  expect(milestoneOfTranscript(reusedWorker, claimedB)).toBe('edited')
  expect(milestoneOfTranscript(reusedWorker, 0)).toBe('reported')
})

it('reads Codex and Antigravity tool calls the same way', async () => {
  const codex = await transcriptOf({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git commit -m x"}' } })
  const agy = await transcriptOf({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: 'gh pr create --fill' } }] }, { type: 'USER_INPUT', content: 'hc send t1 "回报：…"' })
  expect([milestoneOfTranscript(codex), milestoneOfTranscript(agy)]).toEqual(['committed', 'pr'])
  expect(milestoneOfTranscript(undefined)).toBe('started')
  expect(milestoneOfTranscript('/nowhere/at/all.jsonl')).toBe('started')
})

it('reads the checkout: commits past origin/main made since the claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nawaban-checkout-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  expect(await milestoneOfCheckout(dir)).toBe('started')
  await writeFile(join(dir, 'a.txt'), 'x')
  git('add', '.')
  git('commit', '-q', '-m', 'x')
  expect(await milestoneOfCheckout(dir)).toBe('committed')
  expect(await milestoneOfCheckout(dir, Date.now() / 1000 + 3600)).toBe('started')
  expect(await milestoneOfCheckout(join(dir, 'missing'))).toBe('started')
})

it('a GitHub issue claimed on this machine gets its live file from the session that claimed it, and no one else', async () => {
  const boardDir = await mkdtemp(join(tmpdir(), 'nawaban-board-'))
  await mkdir(join(boardDir, 'github-claims'))
  await writeFile(join(boardDir, 'github-claims', 'roubao#950.json'), JSON.stringify({ session: 's1', claimedAt: 100 }))
  await writeFile(join(boardDir, 'github-claims', 'roubao#951.json'), JSON.stringify({ session: 's2', claimedAt: 100 }))
  const held = githubIssuesHeldBy(boardDir, 's1')
  expect(held).toEqual([{ id: 'roubao#950', claimedAt: 100 }])
  const transcript = await transcriptOf({ ...claudeCall('Bash', { command: 'gh pr create --fill' }), timestamp: new Date(200_000).toISOString() })
  await recordProgress({ session_id: 's1', transcript_path: transcript }, held, boardDir, 300)
  expect(JSON.parse(await readFile(join(boardDir, 'progress', 'roubao#950.json'), 'utf8'))).toEqual({ milestone: 'pr', at: 300 })
  expect(githubIssuesHeldBy(join(boardDir, 'nowhere'), 's1')).toEqual([])
})
