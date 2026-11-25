import { Show } from 'solid-js'

export function NoteItem(props: { words: string; when: string; done: boolean; task: string | null; taskHref: (id: string) => string }) {
  return (
    <li data-note data-done={props.done || undefined}>
      <p>{props.words}</p>
      <span>
        {props.when} · {props.done ? '已交编排者' : '等编排者看'}
        <Show when={props.task}>{(task) => <> · <a href={props.taskHref(task())}>{task()}</a></>}</Show>
      </span>
    </li>
  )
}
