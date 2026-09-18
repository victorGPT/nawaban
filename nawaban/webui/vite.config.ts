import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.NAWABAN_API_URL || process.env.WORKOS_API_URL || 'http://127.0.0.1:8813'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    {
      name: 'nawaban-same-origin-answers',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.method !== 'POST' || !['/api/answer', '/api/captures'].includes(request.url?.split('?')[0] ?? '')) {
            next()
            return
          }
          // Validate the browser's original origin before the proxy changes Host.
          // Origin-less CLI writes must go directly to the loopback board listener.
          if (request.headersDistinct.host?.length !== 1 ||
              request.headersDistinct.origin?.length !== 1 ||
              request.headers.origin !== `http://${request.headers.host}` ||
              request.headers['sec-fetch-site'] === 'cross-site') {
            response.writeHead(403, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: 'same-origin browser request required' }))
            return
          }
          request.headers.origin = new URL(apiTarget).origin
          next()
        })
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api/modules': {
        target: process.env.NAWABAN_MODULES_API_TARGET || process.env.WORKOS_MODULES_API_TARGET || process.env.NAWABAN_API_URL || process.env.WORKOS_API_URL || 'http://127.0.0.1:8813',
        changeOrigin: true,
      },
      // Backend reads and inbox answers share the board_view.py listener.
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
