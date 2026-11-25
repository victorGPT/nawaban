import { For } from 'solid-js'

export function Question(props: { text: string; meta: string[] }) {
  return (
    <header data-question>
      <h2>{props.text}</h2>
      <p>
        <For each={props.meta}>{(m) => <span>{m}</span>}</For>
      </p>
    </header>
  )
}
