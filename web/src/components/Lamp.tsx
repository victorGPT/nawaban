export type LampTone = 'wait' | 'working' | 'stopped' | 'done' | 'met' | 'missed' | 'off'

export function Lamp(props: { tone?: LampTone }) {
  return <span data-lamp data-tone={props.tone ?? 'wait'} aria-hidden="true" />
}
