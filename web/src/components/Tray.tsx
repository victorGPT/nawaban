import type { JSX } from '@solidjs/web'

export function Tray(props: { children: JSX.Element }) {
  return <div data-tray>{props.children}</div>
}
