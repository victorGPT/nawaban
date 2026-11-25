import { routeOf } from './logic'

const TOKEN_KEY = 'nawaban-web-token'
const RECONNECT_MS = 3000

export function routeTakingTheTokenIntoThisTab() {
  const { route, token, hashWithoutToken } = routeOf(location.hash)
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token)
    history.replaceState(null, '', location.pathname + location.search + hashWithoutToken)
  }
  return route
}

const headers = () => ({ authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) ?? ''}` })

export class Refusal extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function answered<T>(r: Response): Promise<T> {
  if (r.ok) return r.status === 204 ? (null as T) : r.json()
  if (r.status === 401) throw new Refusal('用 nawaban web 打开这一页', r.status)
  const said = await r.json().then((b: { error?: string }) => b.error, () => null)
  throw new Refusal(said || `看板答 ${r.status}`, r.status)
}

const unreachable = () => Promise.reject(new Refusal('连不上看板（nawaban serve 在跑吗？）', 0))

export const read = <T,>(view: string): Promise<T> => fetch(`/api/nawaban/${view}`, { headers: headers() }).then(answered<T>, unreachable)

export const write = <T,>(view: string, body: unknown): Promise<T> =>
  fetch(`/api/nawaban/${view}`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(answered<T>, unreachable)

export const inProject = (name: string) => '?project=' + encodeURIComponent(name)

export async function onEachChange(then: () => void) {
  for (;;) {
    try {
      const r = await fetch('/api/nawaban/changes', { headers: headers() }).finally(then)
      if (!r.ok) throw new Error(`看板答 ${r.status}`)
      const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader()
      let unfinished = ''
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        const frames = (unfinished + chunk.value).split('\n\n')
        unfinished = frames.pop()!
        if (frames.some((f) => f.startsWith('data:'))) then()
      }
    } catch {}
    await new Promise((done) => setTimeout(done, RECONNECT_MS))
  }
}

export const nowInSeconds = () => Math.floor(Date.now() / 1000)
