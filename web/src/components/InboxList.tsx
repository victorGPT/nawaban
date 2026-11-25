import type { JSX } from '@solidjs/web'
import { Listbox } from '@ui-sdk/solid/listbox'

export function InboxList(props: { label: string; value: string; onPick: (value: string) => void; children: JSX.Element }) {
  return (
    <Listbox aria-label={props.label} data-tray data-inbox-list activation="manual" value={props.value} onValueChange={(next) => next != null && props.onPick(String(next))}>
      {props.children}
    </Listbox>
  )
}
