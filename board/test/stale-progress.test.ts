import { afterAll, beforeAll, expect, it } from 'vitest'
import { board } from '@vercel/board'
import { local } from '@vercel/board/backend-local'
import { verifier } from '../src/server.ts'
import { forgetTheClaimOf, heldBy } from '../src/tasks.ts'

const URL_OF_THE_IN_MEMORY_BOARD = 'http://127.0.0.1:49999/api/board'
const fetchBefore = globalThis.fetch
let team: ReturnType<typeof board>

beforeAll(() => {
  team = board({ backend: local({ memory: true }), authenticate: verifier('test', 'victor'), url: URL_OF_THE_IN_MEMORY_BOARD })
  Object.assign(process.env, { BOARD_URL: URL_OF_THE_IN_MEMORY_BOARD, BOARD_TOKEN: 'test' })
  globalThis.fetch = (input, init) => team.fetch(new Request(input, init))
})
afterAll(() => {
  globalThis.fetch = fetchBefore
})

const labelsOf = async (id: string) => (await team.as(null).thread(id)).message.labels

it('drops a heartbeat read before the release, rather than writing progress back onto a released or retaken ticket', async () => {
  const { task } = await team.as(null).tasks.create('race', { text: 'race', labels: { key: 'RACE' } })
  const claim = await board().as('cc-aaaaaaaa').tasks.claim(task.id)
  const [stale] = await heldBy('aaaaaaaa-session')
  await claim.release()
  await forgetTheClaimOf(task.id)
  await stale!.keep({ milestone: 'reported', at: 100 })
  expect((await labelsOf(task.id)).progress).toBeUndefined()
  await board().as('cc-bbbbbbbb').tasks.claim(task.id)
  await team.as(null).label(task.id, { set: { progress: 'edited', 'progress.at': '200' } })
  await stale!.keep({ milestone: 'reported', at: 300 })
  expect(await labelsOf(task.id)).toMatchObject({ progress: 'edited', 'progress.at': '200' })
})

it('keeps a heartbeat of the session that still holds the ticket', async () => {
  const { task } = await team.as(null).tasks.create('race', { text: 'held', labels: { key: 'HELD' } })
  await board().as('cc-cccccccc').tasks.claim(task.id)
  const [held] = await heldBy('cccccccc-session')
  await held!.keep({ milestone: 'edited', at: 10 })
  const [again] = await heldBy('cccccccc-session')
  await again!.keep({ milestone: 'committed', at: 20 })
  expect(await labelsOf(task.id)).toMatchObject({ progress: 'committed', 'progress.at': '20' })
})
