import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { env: { CODEX_THREAD_ID: '', ANTIGRAVITY_CONVERSATION_ID: '' } } })
