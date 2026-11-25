import type { JSX } from '@solidjs/web'

export function TaskBoard(props: { children: JSX.Element }) {
  return <div data-task-board>{props.children}</div>
}
