import { text } from 'node:stream/consumers'
import type { board } from '@vercel/board'
import { closeGate, mergeGate } from './impact.ts'

export async function guard(team: ReturnType<typeof board>, dir: string): Promise<number> {
  const call = JSON.parse(await text(process.stdin)) as { cwd?: string; tool_input?: { command?: string } }
  const cmd = call.tool_input?.command ?? ''
  let why = closeGate(cmd)
  try {
    why ??= await mergeGate(cmd, call.cwd || process.cwd(), team, dir)
  } catch (error) {
    why = `核不了 KR 影响声明,板读不到:${(error as Error).message}`
  }
  if (!why) return 0
  process.stderr.write(why + '\n')
  return 2
}
