import { Show } from 'solid-js'
import { Lamp, type LampTone } from './Lamp'

export type KrFace = { name: string; status: string; reading: string; measured: boolean; target: string; gap: string | null }

const TONES: Record<string, LampTone> = { met: 'met', missed: 'missed', stale: 'stopped' }

export function KrRow(props: { kr: KrFace }) {
  const k = () => props.kr
  return (
    <li data-kr data-status={k().status}>
      <Lamp tone={TONES[k().status] ?? 'off'} />
      <span data-kr-name>
        {k().name}
        <Show when={k().status === 'missed' && k().gap}>{(gap) => <small>{gap()}</small>}</Show>
      </span>
      <span data-kr-reading data-measured={k().measured || undefined}>
        <b>{k().reading}</b>
        <small>{k().target}</small>
      </span>
    </li>
  )
}
