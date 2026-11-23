import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vite'
import solid from '@solidjs/vite-plugin'

const boardDir = process.env.NAWABAN_BOARD_DIR ?? join(homedir(), '.nawaban', 'board')
const boardPort = process.env.NAWABAN_BOARD_PORT ?? '4100'
const boardTokenReadPerRequestSoABuildNeedsNoBoard = () => `Bearer ${readFileSync(join(boardDir, 'token'), 'utf8').trim()}`
const readsOnlySoNoOtherSiteWritesWithTheToken = (req: { method?: string }) => (req.method === 'GET' ? undefined : false)
const proxy = {
  '/api/board': {
    target: `http://127.0.0.1:${boardPort}`,
    bypass: readsOnlySoNoOtherSiteWritesWithTheToken,
    configure: (proxy: { on: (event: 'proxyReq', listener: (request: { setHeader: (name: string, value: string) => void }) => void) => void }) =>
      proxy.on('proxyReq', (request) => request.setHeader('authorization', boardTokenReadPerRequestSoABuildNeedsNoBoard())),
  },
}

export default defineConfig({ plugins: [solid()], server: { proxy }, preview: { proxy } })
