import { Show } from 'solid-js'
import type { JSX } from '@solidjs/web'

export function QuietLink(props: { href?: string; onClick?: () => void; children: JSX.Element }) {
  return (
    <Show when={props.href} fallback={<button type="button" data-quiet-link onClick={() => props.onClick?.()}>{props.children}</button>}>
      {(href) => <a data-quiet-link href={href()} target={href().startsWith('#') ? undefined : '_blank'} rel="noreferrer">{props.children}</a>}
    </Show>
  )
}
