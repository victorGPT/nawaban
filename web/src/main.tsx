import { createSignal, For, Show } from 'solid-js'
import { render } from '@solidjs/web'
import { Listbox, ListboxItem } from '@ui-sdk/solid/listbox'
import './style.css'

type Row = { id: string; title: string; status: string }
type Board = { columns: { key: string; tasks: Row[] }[] }

const TOKEN_KEY = 'nawaban-web-token'
const RECONNECT_MS = 3000

function tokenMovedFromTheAddressBarIntoThisTab() {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get('k')
  if (fromLink) {
    sessionStorage.setItem(TOKEN_KEY, fromLink)
    history.replaceState(null, '', location.pathname + location.search)
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? ''
}

const headers = { authorization: `Bearer ${tokenMovedFromTheAddressBarIntoThisTab()}` }

const read = <T,>(view: string): Promise<T> =>
  fetch(`/api/nawaban/${view}`, { headers }).then((r) =>
    r.status === 401 ? Promise.reject(new Error('用 nawaban web 打开这一页')) : r.ok ? r.json() : Promise.reject(new Error(`看板答 ${r.status}`)),
  )

async function onEachChange(then: () => void) {
  for (;;) {
    try {
      const r = await fetch('/api/nawaban/changes', { headers })
      const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader()
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) if (chunk.value.includes('data:')) then()
    } catch {}
    await new Promise((done) => setTimeout(done, RECONNECT_MS))
  }
}

function App() {
  const [tasks, setTasks] = createSignal<Row[] | null>(null)
  const [error, setError] = createSignal('')
  const load = () =>
    read<Board>('board')
      .then((b) => (setTasks(b.columns.flatMap((c) => c.tasks)), setError('')))
      .catch((e: Error) => setError(e.message))
  load()
  void onEachChange(load)
  return (
    <main>
      <h1>任务</h1>
      <Show when={!error()} fallback={<p class="error">{error()}</p>}>
        <Show when={tasks()} fallback={<p class="muted">读取中…</p>}>
          {(list) => (
            <Listbox aria-label="任务" class="tasks">
              <For each={list()}>
                {(t) => (
                  <ListboxItem value={t.id} class="task">
                    <span class="key">{t.id}</span>
                    <span class="title">{t.title}</span>
                    <span class="state">{t.status}</span>
                  </ListboxItem>
                )}
              </For>
            </Listbox>
          )}
        </Show>
      </Show>
    </main>
  )
}

render(() => <App />, document.getElementById('root')!)
