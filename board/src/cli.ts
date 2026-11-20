#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { board } from '@vercel/board'
import { createApp } from '@vercel/board/cli'
import { dispatch } from './dispatch.ts'
import { event } from './events.ts'
import { DIR, PORT, serve, urlFor } from './server.ts'
import { run } from './tasks.ts'

const argv = process.argv.slice(2)
if (argv[0] === 'serve') {
  await serve()
} else {
  process.env.BOARD_URL ??= urlFor(PORT)
  if (!process.env.BOARD_TOKEN) {
    try {
      process.env.BOARD_TOKEN = readFileSync(join(DIR, 'token'), 'utf8').trim()
    } catch {
      // ponytail: no token yet means no server yet; the board's own 401 says so.
    }
  }
  const app = createApp({ appName: 'nawaban' })
  process.exitCode = argv[0] === 'event'
    ? await event(argv.slice(1), (args) => app.run(args), board())
    : argv[0] === 'dispatch'
      ? await dispatch(argv.slice(1))
      : (await run(argv)) ?? (await app.run(argv))
}
