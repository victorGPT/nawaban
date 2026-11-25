import { Show } from 'solid-js'
import type { JSX } from '@solidjs/web'

export function PageHead(props: { title: JSX.Element; meta?: string | null; children?: JSX.Element }) {
  return (
    <div data-page-head>
      <h1>
        {props.title}
        <Show when={props.meta}>{(meta) => <small>{meta()}</small>}</Show>
      </h1>
      {props.children}
    </div>
  )
}
