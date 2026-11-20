#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '@vercel/board/cli'
import { DIR, PORT, serve, urlFor } from './server.ts'

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
  process.exitCode = await createApp({ appName: 'nawaban' }).run(argv)
}
