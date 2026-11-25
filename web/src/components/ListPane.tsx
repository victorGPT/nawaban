import type { JSX } from '@solidjs/web'

export function ListPane(props: { children: JSX.Element }) {
  return <div data-list-pane>{props.children}</div>
}
