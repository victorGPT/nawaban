import type { JSX } from '@solidjs/web'

export function ActionRow(props: { children: JSX.Element }) {
  return <div data-action-row>{props.children}</div>
}
