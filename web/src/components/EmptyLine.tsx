import type { JSX } from '@solidjs/web'

export function EmptyLine(props: { error?: boolean; children: JSX.Element }) {
  return (
    <p data-empty-line data-error={props.error || undefined} role={props.error ? 'alert' : undefined}>
      {props.children}
    </p>
  )
}
