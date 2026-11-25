import { createSignal, For, Show } from 'solid-js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@ui-sdk/solid/menu'
import { Icon } from './Icon'

const markChosenSoItBlinksAsTheMenuCloses = (e: Event) => ((e.currentTarget as HTMLElement).dataset.chosen = '')

export function ProjectPicker(props: { value: string; choices: string[]; onPick: (name: string) => void }) {
  const [open, setOpen] = createSignal(false)
  return (
    <Menu open={open()} onOpenChange={setOpen}>
      <MenuTrigger data-kit="button" data-tone="secondary" aria-label="项目">
        {props.value}
        <Icon name="chevron-down" />
      </MenuTrigger>
      <MenuContent data-kit="popup" align="end" sideOffset={14}>
        <For each={props.choices}>
          {(name) => (
            <MenuItem
              data-kit="option"
              onClick={(e: MouseEvent) => (markChosenSoItBlinksAsTheMenuCloses(e), props.onPick(name))}
              onKeyDown={(e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (markChosenSoItBlinksAsTheMenuCloses(e), props.onPick(name))}
            >
              {name}
              <Show when={name === props.value}>
                <span data-chosen-mark aria-hidden="true">✓</span>
              </Show>
            </MenuItem>
          )}
        </For>
      </MenuContent>
    </Menu>
  )
}
