import { createSignal, Show } from 'solid-js'
import { Button } from './Button'
import { EmptyLine } from './EmptyLine'
import { TextArea } from './TextArea'

export function NoteComposer(props: { onKeep: (words: string) => Promise<void> }) {
  const [draft, setDraft] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [failed, setFailed] = createSignal('')
  const keep = async (e: SubmitEvent) => {
    e.preventDefault()
    const words = draft().trim()
    if (!words || saving()) return
    setSaving(true)
    try {
      await props.onKeep(words)
      setDraft((now) => (now.trim() === words ? '' : now))
      setFailed('')
    } catch (err) {
      setFailed((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <form data-note-composer onSubmit={keep}>
      <TextArea label="记一条想法" placeholder="记一条想法" value={draft()} onValueChange={setDraft}>
        <Button tone="primary" type="submit" disabled={!draft().trim() || saving()}>
          {saving() ? '正在记…' : '记下'}
        </Button>
      </TextArea>
      <Show when={failed()}>{(why) => <EmptyLine error>没记上：{why()}。字还在框里，可以再记一次</EmptyLine>}</Show>
    </form>
  )
}
