import type { JSX } from '@solidjs/web'
import { Lamp, type LampTone } from './Lamp'

export function StatusLine(props: { tone: LampTone; children: JSX.Element }) {
  return (
    <p data-status-line role="status">
      <Lamp tone={props.tone} />
      {props.children}
    </p>
  )
}
