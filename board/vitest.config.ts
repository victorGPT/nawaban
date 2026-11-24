import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { testTimeout: 30_000, env: { CODEX_THREAD_ID: '', ANTIGRAVITY_CONVERSATION_ID: '' } } })
