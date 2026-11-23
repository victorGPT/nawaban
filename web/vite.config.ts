import { defineConfig } from 'vite'
import solid from '@solidjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({ plugins: [solid(), tailwindcss()] })
