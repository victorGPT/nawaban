import { expect, it } from 'vitest'
import { SCHEMAS } from '../src/schemas.ts'
import registered from './registered-schemas.json' with { type: 'json' }

const REGISTERED: Record<string, { description: string; schema: unknown }> = registered

it('keeps every registered schema as it was registered, so a change has to come as a new version', () => {
  for (const [id, { description, schema }] of Object.entries(SCHEMAS)) {
    expect(REGISTERED[id], `${id} 是新 schema：加进 test/registered-schemas.json`).toBeDefined()
    expect({ description, schema }, `${id} 已注册，看板不收改动（schema_immutable）：改回原样，或注册 @${Number(id.split('@')[1]) + 1}`).toEqual(REGISTERED[id])
  }
})
