import { createSignal, For, Show } from 'solid-js'
import { DotMeter } from './DotMeter'
import { KrRow, type KrFace } from './KrRow'
import { QuietLink } from './QuietLink'

export type ObjectiveFace = { name: string; met: number; total: number; standing: 'missed' | 'unsure' | 'met'; krs: KrFace[]; untested: KrFace[]; metKrs: KrFace[] }

function Fold(props: { label: string; krs: KrFace[] }) {
  const [open, setOpen] = createSignal(false)
  return (
    <Show when={props.krs.length}>
      <div data-fold>
        <QuietLink onClick={() => setOpen((v) => !v)}>{open() ? '收起' : props.label}</QuietLink>
      </div>
      <Show when={open()}>
        <ul data-krs data-quiet>
          <For each={props.krs}>{(k) => <KrRow kr={k} />}</For>
        </ul>
      </Show>
    </Show>
  )
}

export function ObjectivePanel(props: { objective: ObjectiveFace }) {
  const o = () => props.objective
  const allMet = () => o().standing === 'met'
  return (
    <section data-objective data-standing={o().standing}>
      <header>
        <h2>{o().name}</h2>
        <DotMeter lit={o().met} total={o().total} />
        <b>{o().met}/{o().total}</b>
      </header>
      <Show when={!allMet() && o().krs.length}>
        <ul data-krs>
          <For each={o().krs}>{(k) => <KrRow kr={k} />}</For>
        </ul>
      </Show>
      <Fold label={o().untested.length + ' 条未测'} krs={o().untested} />
      <Fold label={(allMet() ? '全部达标，' : '') + o().metKrs.length + ' 条达标'} krs={o().metKrs} />
    </section>
  )
}
