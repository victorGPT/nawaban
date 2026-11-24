#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { board } from '@vercel/board'
import { createApp } from '@vercel/board/cli'
import { dispatch } from './dispatch.ts'
import { event } from './events.ts'
import { guard } from './guard.ts'
import { importOld } from './import.ts'
import { jsonOkr, okr } from './okr.ts'
import { inbox, index, page } from './orchestrator.ts'
import { boardDirAsConfiguredWhenAsked, DIR, PORT, serve, urlFor, web } from './server.ts'
import { progress } from './progress.ts'
import { heldBy, run } from './tasks.ts'
import { json } from './views.ts'

function tokenOfServedBoardElseLetItsOwn401Answer(): string | undefined {
  try {
    return readFileSync(join(DIR, 'token'), 'utf8').trim()
  } catch {
    return undefined
  }
}

function pointAtThisMachinesBoard() {
  process.env.BOARD_URL ??= urlFor(PORT)
  if (process.env.BOARD_TOKEN) return
  const token = tokenOfServedBoardElseLetItsOwn401Answer()
  if (token !== undefined) process.env.BOARD_TOKEN = token
}

async function runCommand(argv: string[]): Promise<number> {
  const app = createApp({ appName: 'nawaban' })
  const [command, ...rest] = argv
  const nawabanCommands: Record<string, () => Promise<number>> = {
    event: () => event(rest, (args) => app.run(args), board()),
    dispatch: () => dispatch(rest),
    import: () => importOld(rest, board().as(null), boardDirAsConfiguredWhenAsked()),
    guard: () => guard(board(), DIR),
    okr: () => okr(rest, board(), DIR),
    index: () => index(rest, board()),
    inbox: () => inbox(rest, board(), DIR),
    web: () => web(),
    progress: () => progress(heldBy, DIR),
    page: () => page(rest, board()),
    json: () => (rest[0] === 'okr' ? jsonOkr(rest.slice(1), board(), DIR) : json(rest, board(), DIR)),
  }
  if (command !== undefined && Object.hasOwn(nawabanCommands, command)) return nawabanCommands[command]!()
  return (await run(argv)) ?? (await app.run(argv))
}

const argv = process.argv.slice(2)
if (argv[0] === 'serve') {
  await serve()
} else {
  pointAtThisMachinesBoard()
  process.exitCode = await runCommand(argv)
}
