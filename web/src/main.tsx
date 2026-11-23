import { createSignal, For, Show } from 'solid-js'
import { render } from '@solidjs/web'
import { Listbox, ListboxItem } from '@ui-sdk/solid/listbox'
import './style.css'

type Task = { id: string; text: string; labels: Record<string, string>; task: { state: string } }

const title = (t: Task) => t.text.split('\n')[0]
const key = (t: Task) => t.labels.key ?? `#${t.id}`

function App() {
  const [tasks, setTasks] = createSignal<Task[] | null>(null)
  const [error, setError] = createSignal('')
  fetch('/api/board/tasks?state=all&limit=200')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`board answered ${r.status}`))))
    .then((page: { tasks: { message: Task }[] }) => setTasks(page.tasks.map((t) => t.message)))
    .catch((e: Error) => setError(e.message))
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
                    <span class="key">{key(t)}</span>
                    <span class="title">{title(t)}</span>
                    <span class="state">{t.task.state}</span>
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
