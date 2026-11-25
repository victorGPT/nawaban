import { text } from 'node:stream/consumers'
import type { board } from '@vercel/board'
import { whyThisGhWriteMustNotRun } from './github-account.ts'
import { closeGate, mergeGate } from './impact.ts'

type BashCall = { cwd?: string; tool_input?: { command?: string } }

const LET_IT_RUN = 0
const HOOK_REFUSES_TOOL_CALL = 2

async function whyThisBashCallMustNotRun(call: BashCall, team: ReturnType<typeof board>, dir: string): Promise<string | null> {
  const cmd = call.tool_input?.command ?? ''
  const agentClosingTask = closeGate(cmd)
  if (agentClosingTask) return agentClosingTask
  try {
    return await mergeGate(cmd, call.cwd || process.cwd(), team, dir)
  } catch (error) {
    return `核不了 KR 影响声明,板读不到:${(error as Error).message}`
  }
}

export async function ghAccountGuard(dir: string): Promise<number> {
  const call = JSON.parse(await text(process.stdin)) as BashCall
  const why = await whyThisGhWriteMustNotRun(call.tool_input?.command ?? '', call.cwd || process.cwd(), dir).catch((error: Error) => `核不了这次 gh 写操作该用哪个账号：${error.message}`)
  if (!why) return LET_IT_RUN
  process.stderr.write(why + '\n')
  return HOOK_REFUSES_TOOL_CALL
}

export async function guard(team: ReturnType<typeof board>, dir: string): Promise<number> {
  const call = JSON.parse(await text(process.stdin)) as BashCall
  const why = await whyThisBashCallMustNotRun(call, team, dir)
  if (!why) return LET_IT_RUN
  process.stderr.write(why + '\n')
  return HOOK_REFUSES_TOOL_CALL
}
