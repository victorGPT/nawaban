import { createEffect, createSignal, For, Show } from 'solid-js'
import { inProject, read, write } from '../api'
import { localMonthDayTime, taskHref, WINDOW_WORDS } from '../logic'
import { Device } from '../components/Device'
import { EmptyLine } from '../components/EmptyLine'
import { NoteComposer } from '../components/NoteComposer'
import { NoteItem } from '../components/NoteItem'
import { NoteList } from '../components/NoteList'
import { PageHead } from '../components/PageHead'
import { ProjectPicker } from '../components/ProjectPicker'

type Note = { id: string; words: string; at: string; done: boolean; task: string | null }

export function NotesPage(props: { project: string; projects: string[]; onPick: (name: string) => void; changes: number }) {
  const [notes, setNotes] = createSignal<{ of: string; items: Note[] } | null>(null)
  const [failure, setFailure] = createSignal('')
  let reads = 0
  const load = (p: string) => {
    const mine = ++reads
    return read<{ items: Note[] }>('inbox' + inProject(p)).then(
      (b) => void (mine === reads && (setNotes({ of: p, items: b.items }), setFailure(''))),
      (e: Error) => void (mine === reads && setFailure(e.message)),
    )
  }
  createEffect(
    () => ({ p: props.project, n: props.changes }),
    ({ p }) => void load(p),
  )
  const shown = () => (notes()?.of === props.project ? notes()!.items : null)
  const [unheard, setUnheard] = createSignal(false)
  const keep = async (words: string) => {
    setUnheard(!(await write<{ heard: boolean }>('inbox' + inProject(props.project), { words })).heard)
    await load(props.project)
  }
  return (
    <Device label="随手记" layout="narrow">
      <PageHead title="随手记">
        <ProjectPicker value={props.project} choices={props.projects} onPick={props.onPick} />
      </PageHead>
      <NoteComposer onKeep={keep} />
      <Show when={unheard()}>
        <EmptyLine>记下了，编排者不在线，等它下次看</EmptyLine>
      </Show>
      <Show when={shown()} fallback={<EmptyLine error={!!failure()}>{failure() || WINDOW_WORDS.zh.loading}</EmptyLine>}>
        <Show when={shown()!.length} fallback={<EmptyLine>还没有记下的想法</EmptyLine>}>
          <NoteList>
            <For each={shown()!}>{(x) => <NoteItem words={x.words} when={localMonthDayTime(Date.parse(x.at))} done={x.done} task={x.task} taskHref={taskHref} />}</For>
          </NoteList>
        </Show>
      </Show>
    </Device>
  )
}
