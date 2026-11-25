import { Show } from 'solid-js'

export type TaskCardFace = { id: string; title: string; state: string; note: string | null; spec: { done: number; total: number } | null; since: string; signal: string | null }

export function TaskCard(props: { href: string; card: TaskCardFace }) {
  const c = () => props.card
  return (
    <a data-task-card href={props.href} data-state={c().state}>
      <span data-task-title>{c().title}</span>
      <Show when={c().state !== 'done' && c().note}>{(note) => <span data-task-note>{note()}</span>}</Show>
      <span data-task-meta>
        <code>{c().id}</code>
        <Show when={c().spec}>{(spec) => <span>{spec().done}/{spec().total} 张</span>}</Show>
        <Show when={c().since && !c().signal}><span>{c().since}</span></Show>
        <Show when={c().signal}>{(signal) => <mark>{signal()}</mark>}</Show>
      </span>
    </a>
  )
}
