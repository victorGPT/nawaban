import { createSignal, For, Show } from 'solid-js'
import { QuietLink } from './QuietLink'

const BULLET = /^[-•*]\s+/
const CLAMPED_PAST = 160

export function Prose(props: { text?: string; html?: string; clamp?: boolean }) {
  const lines = () => (props.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const bullets = () => lines().length > 1 && lines().every((l) => BULLET.test(l))
  const long = () => (props.html ?? props.text ?? '').length > CLAMPED_PAST
  const [open, setOpen] = createSignal(false)
  const clamped = () => !!props.clamp && long() && !open()
  return (
    <div data-prose data-clamped={clamped() || undefined}>
      <Show when={props.html == null} fallback={<div innerHTML={props.html} />}>
        <Show when={bullets()} fallback={<p>{lines().join(' ')}</p>}>
          <ul>
            <For each={lines()}>{(l) => <li>{l.replace(BULLET, '')}</li>}</For>
          </ul>
        </Show>
      </Show>
      <Show when={clamped()}>
        <QuietLink onClick={() => setOpen(true)}>展开</QuietLink>
      </Show>
    </div>
  )
}
