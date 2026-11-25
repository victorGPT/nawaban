import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { inProject, nowInSeconds, read } from '../api'
import { clockOf, detailView, stampOf, type Detail, type DetailView, type Ref, type Row } from '../detail-logic'
import { boardTaskOf, taskHref, WINDOW_WORDS, type Board } from '../logic'
import type { LampTone } from '../components/Lamp'
import type { TimelineDay } from '../components/Timeline'
import { Device } from '../components/Device'
import { EmptyLine } from '../components/EmptyLine'
import { Facts } from '../components/Facts'
import { Lamp } from '../components/Lamp'
import { PageHead } from '../components/PageHead'
import { Prose } from '../components/Prose'
import { QuietLink } from '../components/QuietLink'
import { Timeline } from '../components/Timeline'

const W = WINDOW_WORDS.zh
const STATE_LAMPS: Record<DetailView['state'], LampTone> = { todo: 'off', working: 'working', stopped: 'stopped', done: 'done' }
const RULED_BY = { owner: '决策者', agent: '编排者代定' }

const refs = (list: Ref[]) => (
  <ul>
    <For each={list}>{(r) => <li><code>{r.id}</code><a href={taskHref(r.id)}>{r.title}</a></li>}</For>
  </ul>
)

const rowOf = (row: Row, waiting: string | null) => ({
  at: clockOf(row.at),
  line: row.line,
  full: row.full,
  lead: row.kind === 'ask' ? (row.line === waiting ? W.waiting : '问') + '：' : row.kind === 'decision' && row.by === 'agent' ? '代定：' : null,
  owner: row.kind === 'decision' && row.by === 'owner',
})

export function TaskPage(props: { id: string; project: string; changes: number }) {
  const [fetched, setFetched] = createSignal<{ of: string; detail: Detail; board: Board | null } | null>(null)
  const [failure, setFailure] = createSignal('')
  const [everything, setEverything] = createSignal(false)
  let reads = 0
  createEffect(
    () => ({ id: props.id, p: props.project, n: props.changes }),
    ({ id, p }) => {
      const mine = ++reads
      Promise.all([read<Detail>('task/' + encodeURIComponent(id) + inProject(p)), read<Board>('board' + inProject(p)).catch(() => null)]).then(
        ([detail, board]) => mine === reads && (setFetched({ of: id, detail, board }), setFailure('')),
        (e: Error) => mine === reads && setFailure(e.message),
      )
    },
  )
  const view = createMemo(() => {
    const r = fetched()
    if (!r || r.of !== props.id || r.detail.id !== props.id) return null
    return { detail: r.detail, v: detailView(r.detail, boardTaskOf(r.board, props.id), nowInSeconds(), r.board?.tracker === 'github') }
  })
  return (
    <Device label="任务详情" layout="narrow">
      <Show when={view()} fallback={<EmptyLine error={!!failure()}>{failure() || W.loading}</EmptyLine>}>
        {(s) => {
          const v = () => s().v
          const f = () => s().v.facts
          const days = (): TimelineDay[] => (everything() ? v().timeline.everything : v().timeline.forTheOwner).map((d) => ({ label: d.label, rows: d.rows.map((r) => rowOf(r, v().waiting)) }))
          const shownRows = () => v().timeline.forTheOwner.reduce((n, d) => n + d.rows.length, 0)
          return (
            <>
              <PageHead title={<><Lamp tone={f().cancelled ? 'off' : STATE_LAMPS[v().state]} /> {s().detail.title}</>} meta={[f().stateWord, s().detail.id, s().detail.project].join(' · ')}>
                <QuietLink href="#tasks">回到任务</QuietLink>
              </PageHead>
              <Facts
                rows={[
                  (v().headline.length > 0 || v().stepLine) && [
                    v().waiting ? W.waiting : '现在',
                    <p>
                      <For each={v().headline}>{(part) => (typeof part === 'string' ? part : <a href={part.href} target="_blank" rel="noreferrer">{part.label}</a>)}</For>
                      <Show when={v().stepLine}>{(line) => <em>{line()}</em>}</Show>
                    </p>,
                  ],
                  v().steps && ['进度', <p><For each={v().steps!}>{(step, i) => <>{i() > 0 ? ' → ' : ''}{step.status === 'in_progress' ? <b>{step.word}</b> : step.status === 'pending' ? <em>{step.word}</em> : step.word}</>}</For></p>],
                  v().ruling && ['已定', <p>{v().ruling!.line}<em>{RULED_BY[v().ruling!.by]} · {stampOf(v().ruling!.at)}{v().ruling!.question ? ' · 问：' + v().ruling!.question : ''}</em></p>],
                  f().holder && ['负责', <p>{[f().holder!.name, f().holder!.runs].filter(Boolean).join(' · ')}<Show when={f().holder!.terminal}><em>{f().holder!.terminal}</em></Show></p>],
                  f().dispatchedAt != null && ['派发', <p>{[f().dispatcher, stampOf(f().dispatchedAt!)].filter(Boolean).join(' · ')}</p>],
                  f().lane && ['泳道', <p>{f().lane}</p>],
                  f().goal && ['目标', <p>{f().goal}</p>],
                  f().parent && ['上级', refs([f().parent!])],
                  f().children.length > 0 && ['子票', refs(f().children)],
                  f().blockedBy.length > 0 && ['被挡', refs(f().blockedBy)],
                  f().dependents.length > 0 && ['挡着', refs(f().dependents)],
                  f().outputs.length > 0 && ['产出', <ul><For each={f().outputs}>{(o) => <li>{o.href ? <a href={o.href} target="_blank" rel="noreferrer">{o.label}</a> : o.label}<Show when={o.note}><em>{o.note}</em></Show></li>}</For></ul>],
                  ['建于', <p>{stampOf(f().createdAt)}<Show when={f().took}><em>{f().took}</em></Show></p>],
                  ...v().sections.map((section, i) => [section.label ?? '正文', <Prose html={section.html} clamp={i === 0} />] as [string, ReturnType<typeof Prose>]),
                ]}
              />
              <Show when={v().timeline.total}>
                <Timeline
                  days={days()}
                  more={v().timeline.total > shownRows() ? (everything() ? W.less : '显示全部 ' + v().timeline.total + ' 条') : null}
                  onMore={() => setEverything((all) => !all)}
                />
              </Show>
            </>
          )
        }}
      </Show>
    </Device>
  )
}
