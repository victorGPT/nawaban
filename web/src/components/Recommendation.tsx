import { Show } from 'solid-js'

export function Recommendation(props: { letter: string | null; why: string; model?: string | null }) {
  return (
    <p data-recommendation>
      <b>{props.letter ? '建议 ' + props.letter : '建议'}</b>
      <span>{props.why}</span>
      <Show when={props.model}>{(model) => <small>{model()}</small>}</Show>
    </p>
  )
}
