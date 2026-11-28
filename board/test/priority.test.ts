import { expect, it } from 'vitest'
import { tiersRaisedToWhatTheyBlock } from '../src/priority.ts'

it('raises every ticket under a P0, both sides of a diamond included', () => {
  const tiers = tiersRaisedToWhatTheyBlock([
    { id: 'A', tier: 'P2', needs: [] },
    { id: 'B', tier: 'P2', needs: ['A'] },
    { id: 'C', tier: 'P2', needs: ['A'] },
    { id: 'D', tier: 'P0', needs: ['B', 'C'] },
    { id: 'E', tier: 'P2', needs: [] },
  ])
  expect(Object.fromEntries(tiers)).toEqual({ A: 'P0', B: 'P0', C: 'P0', D: 'P0', E: 'P2' })
})
