import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { inProject, nowInSeconds, read } from '../api'
import { boardColumns, cardSignal, sinceLabel, summaryOf, taskGroups, taskHref, WINDOW_WORDS, type Board, type Group } from '../logic'
import type { LampTone } from '../components/Lamp'
import { Device } from '../components/Device'
import { EmptyLine } from '../components/EmptyLine'
import { PageHead } from '../components/PageHead'
import { ProjectPicker } from '../components/ProjectPicker'
import { TaskBoard } from '../components/TaskBoard'
import { TaskCard } from '../components/TaskCard'
import { TaskColumn } from '../components/TaskColumn'

const W = WINDOW_WORDS.zh
const COLUMN_LAMPS: Record<Group, LampTone> = { todo: 'off', working: 'working', stopped: 'stopped', done: 'done' }

export function TasksPage(props: { project: string; projects: string[]; onPick: (name: string) => void; changes: number }) {
  const [board, setBoard] = createSignal<{ of: string; board: Board } | null>(null)
  const [failure, setFailure] = createSignal('')
  const [doneShownAll, setDoneShownAll] = createSignal(false)
  let reads = 0
  createEffect(
    () => ({ p: props.project, n: props.changes }),
    ({ p }) => {
      const mine = ++reads
      read<Board>('board' + inProject(p)).then(
        (b) => mine === reads && (setBoard({ of: p, board: b }), setFailure('')),
        (e: Error) => mine === reads && setFailure(e.message),
      )
    },
  )
  const shown = () => (board()?.of === props.project ? board()!.board : null)
  const now = () => (props.changes, nowInSeconds())
  const columns = createMemo(() => boardColumns(taskGroups(shown(), now()), doneShownAll()))
  return (
    <Device label="任务" layout="wide">
      <PageHead title="任务" meta={summaryOf(shown(), now()) || null}>
        <ProjectPicker value={props.project} choices={props.projects} onPick={props.onPick} />
      </PageHead>
      <Show when={shown()} fallback={<EmptyLine error={!!failure()}>{failure() || W.loading}</EmptyLine>}>
        <TaskBoard>
          <For each={columns()}>
            {(c) => (
              <TaskColumn
                name={W.groups[c.group]}
                tone={COLUMN_LAMPS[c.group]}
                count={c.count}
                more={c.more ? (c.more.hidden ? W.more(c.more.hidden) : W.less) : null}
                onMore={() => setDoneShownAll((all) => !all)}
              >
                <For each={c.items}>
                  {(x) => (
                    <TaskCard
                      href={taskHref(x.id)}
                      card={{ id: x.id, title: x.title, state: x.state, note: x.note, spec: x.spec, since: x.state === 'todo' ? '' : sinceLabel(x, now(), 'zh'), signal: cardSignal(x, now()) }}
                    />
                  )}
                </For>
              </TaskColumn>
            )}
          </For>
        </TaskBoard>
      </Show>
    </Device>
  )
}
