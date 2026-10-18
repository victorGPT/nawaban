import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiTarget = process.env.NAWABAN_API_URL || 'http://127.0.0.1:8813'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
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
      // The board_view.py listener serves the read-only API.
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
