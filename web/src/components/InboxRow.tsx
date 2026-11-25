import { ListboxItem } from '@ui-sdk/solid/listbox'
import { Lamp, type LampTone } from './Lamp'

export function InboxRow(props: { value: string; title: string; meta: string; tone?: LampTone; onOpen?: () => void }) {
  return (
    <ListboxItem value={props.value} data-inbox-row onClick={() => props.onOpen?.()} onKeyDown={(e: KeyboardEvent) => e.key === 'Enter' && props.onOpen?.()}>
      <Lamp tone={props.tone} />
      <span data-inbox-title>{props.title}</span>
      <span data-inbox-meta>{props.meta}</span>
    </ListboxItem>
  )
}
