import { createSignal, For, Show } from 'solid-js'
import { render } from '@solidjs/web'
import { Listbox, ListboxItem } from '@ui-sdk/solid/listbox'
import { Inbox } from './inbox'
import './style.css'

type Row = { id: string; title: string; status: string }
type Board = { columns: { key: string; tasks: Row[] }[] }
type Project = { name: string; open: number }

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
      const r = await fetch('/api/nawaban/changes', { headers }).finally(then)
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

function App() {
  const [tasks, setTasks] = createSignal<Row[] | null>(null)
  const [error, setError] = createSignal('')
  const load = () =>
    read<Board>('board')
      .then((b) => (setTasks(b.columns.flatMap((c) => c.tasks)), setError('')))
      .catch((e: Error) => setError(e.message))
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

function InboxEntry() {
  const [project, setProject] = createSignal<string | null>(new URLSearchParams(location.search).get('project'))
  const [changes, setChanges] = createSignal(0)
  const [error, setError] = createSignal('')
  if (!project())
    read<{ projects: Project[] }>('projects')
      .then((r) => setProject([...r.projects].sort((a, b) => b.open - a.open)[0]?.name ?? null))
      .catch((e: Error) => setError(e.message))
  void onEachChange(() => setChanges((n) => n + 1))
  return (
    <main>
      <h1>收件箱 <span class="muted">{project()}</span></h1>
      <Show when={!error()} fallback={<p class="error">{error()}</p>}>
        <Show when={project()} fallback={<p class="muted">读取中…</p>}>
          {(p) => <Inbox project={p()} headers={headers} changes={changes()} taskHref={(key) => '#task-' + encodeURIComponent(key)} />}
        </Show>
      </Show>
    </main>
  )
}

render(() => (location.hash === '#inbox' ? <InboxEntry /> : <App />), document.getElementById('root')!)
