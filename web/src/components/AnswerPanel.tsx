import type { JSX } from '@solidjs/web'

export function AnswerPanel(props: { children: JSX.Element }) {
  return <section data-answer-panel>{props.children}</section>
}
