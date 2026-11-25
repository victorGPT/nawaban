import { For } from 'solid-js'
import type { JSX } from '@solidjs/web'

export type Fact = [label: string, value: JSX.Element]

type NoFact = null | false | undefined | '' | 0

export function Facts(props: { rows: (Fact | NoFact)[] }) {
  const rows = () => props.rows.filter((r): r is Fact => !!r)
  return (
    <dl data-facts>
      <For each={rows()}>
        {([label, value]) => (
          <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  )
}
