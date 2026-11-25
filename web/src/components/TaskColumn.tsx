import { Show } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Lamp, type LampTone } from './Lamp'
import { QuietLink } from './QuietLink'
import { Tray } from './Tray'

export function TaskColumn(props: { name: string; tone: LampTone; count: number; more: string | null; onMore: () => void; children: JSX.Element }) {
  return (
    <section data-task-column aria-label={props.name + ' ' + props.count}>
      <header>
        <Lamp tone={props.tone} />
        {props.name}
        <b>{props.count}</b>
      </header>
      <Tray>
        <Show when={props.count} fallback={<p data-column-empty>没有</p>}>
          {props.children}
        </Show>
        <Show when={props.more}>{(more) => <QuietLink onClick={props.onMore}>{more()}</QuietLink>}</Show>
      </Tray>
    </section>
  )
}
