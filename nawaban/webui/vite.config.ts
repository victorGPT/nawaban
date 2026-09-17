import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    proxy: {
      // NAWABAN 板的只读 API + 收件箱写通道,由 board_view.py 在 8813 提供
      '/api': {
        target: 'http://127.0.0.1:8813',
        changeOrigin: true,
      },
    },
  },
})
