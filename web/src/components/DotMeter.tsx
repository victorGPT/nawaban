import { For } from 'solid-js'

export function DotMeter(props: { lit: number; total: number }) {
  return (
    <span data-dot-meter role="img" aria-label={props.lit + '/' + props.total + ' 条达标'}>
      <For each={Array.from({ length: props.total }, (_, i) => i < props.lit)}>{(on) => <i data-on={on || undefined} />}</For>
    </span>
  )
}
