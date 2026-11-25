import type { JSX } from '@solidjs/web'

export function NoteList(props: { children: JSX.Element }) {
  return <ul data-note-list>{props.children}</ul>
}
