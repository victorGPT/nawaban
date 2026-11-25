import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { inProject, read } from '../api'
import { OKR_WORDS, okrReadingOfFailure, okrView, WINDOW_WORDS, type KrRow } from '../logic'
import type { KrFace } from '../components/KrRow'
import { Device } from '../components/Device'
import { EmptyLine } from '../components/EmptyLine'
import { ObjectivePanel } from '../components/ObjectivePanel'
import { PageHead } from '../components/PageHead'
import { ProjectPicker } from '../components/ProjectPicker'

const O = OKR_WORDS.zh

const faceOf = (k: KrRow): KrFace => ({ name: k.name, status: k.status, reading: k.measured ? k.value : O.status[k.status], measured: k.measured, target: k.target, gap: k.gap })

export function OkrPage(props: { project: string; projects: string[]; onPick: (name: string) => void; changes: number }) {
  const [okr, setOkr] = createSignal<{ of: string; reading: unknown; failure: string } | null>(null)
  let reads = 0
  createEffect(
    () => ({ p: props.project, n: props.changes }),
    ({ p }) => {
      const mine = ++reads
      read('okr' + inProject(p)).then(
        (x) => mine === reads && setOkr({ of: p, reading: x, failure: '' }),
        (e: Error) => mine === reads && setOkr({ of: p, reading: okrReadingOfFailure(e), failure: okrReadingOfFailure(e) ? '' : e.message }),
      )
    },
  )
  const shown = () => (okr()?.of === props.project ? okr() : null)
  const view = createMemo(() => okrView(shown()?.reading))
  return (
    <Device label="OKR" layout="narrow">
      <PageHead
        title={<Show when={view()} fallback="OKR">{(v) => <><b data-okr-count>{v().met}</b>/{v().total} 条达标</>}</Show>}
        meta={view()?.measured ? view()!.measured + ' 量' : null}
      >
        <ProjectPicker value={props.project} choices={props.projects} onPick={props.onPick} />
      </PageHead>
      <Show when={shown()} fallback={<EmptyLine>{WINDOW_WORDS.zh.loading}</EmptyLine>}>
        <Show when={!shown()!.failure} fallback={<EmptyLine error>{shown()!.failure}</EmptyLine>}>
          <Show when={view()} fallback={<EmptyLine>{O.noObjective}</EmptyLine>}>
            {(v) => (
              <For each={v().objectives}>
                {(o) => <ObjectivePanel objective={{ name: o.name, met: o.met, total: o.total, standing: o.standing, krs: o.krs.map(faceOf), untested: o.untestedKrs.map(faceOf), metKrs: o.metKrs.map(faceOf) }} />}
              </For>
            )}
          </Show>
        </Show>
      </Show>
    </Device>
  )
}
