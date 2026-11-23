import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import solid from '@solidjs/vite-plugin'

const boardDir = process.env.NAWABAN_BOARD_DIR
const boardPort = process.env.NAWABAN_BOARD_PORT ?? '4100'
const tokenHeldByTheProxyNeverByThePage = () => ({ authorization: `Bearer ${readFileSync(join(boardDir!, 'token'), 'utf8').trim()}` })
const proxy = boardDir ? { '/api/board': { target: `http://127.0.0.1:${boardPort}`, headers: tokenHeldByTheProxyNeverByThePage() } } : undefined

export default defineConfig({ plugins: [solid()], server: { proxy }, preview: { proxy } })
