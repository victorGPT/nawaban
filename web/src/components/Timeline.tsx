import { createSignal, For, Show } from 'solid-js'
import { QuietLink } from './QuietLink'

export type TimelineRow = { at: string; line: string; full: string; lead: string | null; owner: boolean }
export type TimelineDay = { label: string; rows: TimelineRow[] }

function Row(props: { row: TimelineRow }) {
  const [open, setOpen] = createSignal(false)
  const opens = () => props.row.full !== props.row.line
  return (
    <li data-timeline-row data-owner={props.row.owner || undefined}>
      <time>{props.row.at}</time>
      <button type="button" aria-expanded={opens() ? (open() ? 'true' : 'false') : undefined} disabled={!opens()} onClick={() => setOpen((v) => !v)} data-open={open() || undefined}>
        <Show when={props.row.lead}>{(lead) => <b>{lead()}</b>}</Show>
        {open() ? props.row.full : props.row.line}
      </button>
    </li>
  )
}

export function Timeline(props: { days: TimelineDay[]; more: string | null; onMore: () => void }) {
  return (
    <div data-timeline>
      <For each={props.days}>
        {(day) => (
          <section>
            <h3>{day.label}</h3>
            <ol>
              <For each={day.rows}>{(row) => <Row row={row} />}</For>
            </ol>
          </section>
        )}
      </For>
      <Show when={props.more}>{(more) => <QuietLink onClick={props.onMore}>{more()}</QuietLink>}</Show>
    </div>
  )
}
