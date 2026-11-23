import { createEffect, createSignal, For, Show } from 'solid-js'
import { localMonthDayTime } from './logic'
import { button, card, cn, empty, input } from './ui'

export type InboxEntry = { id: string; words: string; at: string; done: boolean; task: string | null }

type Props = { project: string; headers: Record<string, string>; changes: number; taskHref: (key: string) => string }

async function said(r: Response) {
  if (r.status === 401) return '用 nawaban web 重新打开这一页'
  const error = await r.json().then((b: { error?: string }) => b.error, () => null)
  return error || `看板答 ${r.status}`
}

const ask = (props: Props, path: string, init?: RequestInit) =>
  fetch(`/api/nawaban/inbox${path}`, { ...init, headers: { ...props.headers, 'content-type': 'application/json' } }).then(
    async (r) => (r.ok ? r : Promise.reject(new Error(await said(r)))),
    () => Promise.reject(new Error('连不上看板（nawaban serve 在跑吗？）')),
  )

export function Inbox(props: Props) {
  const [items, setItems] = createSignal<InboxEntry[] | null>(null)
  const [loadError, setLoadError] = createSignal('')
  const [draft, setDraft] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [saveError, setSaveError] = createSignal('')
  const [dropping, setDropping] = createSignal<string | null>(null)
  const [dropError, setDropError] = createSignal<{ id: string; message: string } | null>(null)

  const query = () => `?project=${encodeURIComponent(props.project)}`
  let reads = 0
  const load = async () => {
    const mine = ++reads
    try {
      const list = ((await (await ask(props, query())).json()) as { items: InboxEntry[] }).items
      if (mine === reads) (setItems(list), setLoadError(''))
    } catch (e) {
      if (mine === reads) setLoadError((e as Error).message)
    }
  }
  createEffect(
    () => ({ p: props.project, n: props.changes }),
    () => void load(),
  )

  const keep = async (e: SubmitEvent) => {
    e.preventDefault()
    const words = draft().trim()
    if (!words || saving()) return
    setSaving(true)
    try {
      await ask(props, query(), { method: 'POST', body: JSON.stringify({ words }) })
      setDraft((now) => (now.trim() === words ? '' : now))
      setSaveError('')
      await load()
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const drop = async (id: string) => {
    setDropping(id)
    try {
      await ask(props, `/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setDropError(null)
      await load()
    } catch (err) {
      setDropError({ id, message: (err as Error).message })
    } finally {
      setDropping(null)
    }
  }

  const open = () => (items() ?? []).filter((x) => !x.done)
  const handled = () => (items() ?? []).filter((x) => x.done)

  const Item = (p: { x: InboxEntry }) => (
    <div class="flex flex-col gap-1.5 px-4 py-3">
      <p class={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', p.x.done ? 'text-muted-foreground' : 'text-foreground')}>{p.x.words}</p>
      <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span class="shrink-0 text-subtle-foreground tabular-nums">{localMonthDayTime(Date.parse(p.x.at))}</span>
        <Show when={p.x.done}>
          <Show when={p.x.task} fallback={<span>编排者已处理</span>}>
            {(task) => (
              <a class="text-primary underline-offset-4 hover:underline" href={props.taskHref(task())}>
                已转任务 {task()}
              </a>
            )}
          </Show>
        </Show>
        <button type="button" class={cn(button('ghost', 'xs'), 'ml-auto text-muted-foreground')} disabled={dropping() === p.x.id} onClick={() => void drop(p.x.id)}>
          {dropping() === p.x.id ? '删除中…' : '删除'}
        </button>
      </div>
      <Show when={dropError()?.id === p.x.id}>
        <p class="text-xs text-destructive [overflow-wrap:anywhere]">没删掉：{dropError()!.message}</p>
      </Show>
    </div>
  )

  const list = 'flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card text-sm shadow-card'

  return (
    <section class="flex flex-col gap-4">
      <form class={cn(card, 'flex-row gap-2 px-4 max-md:flex-col')} onSubmit={keep}>
        <input
          class={input}
          data-slot="input"
          aria-label="记一条想法"
          placeholder="记一条想法，回车交给编排者"
          maxlength={2000}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" class={button()} disabled={!draft().trim() || saving()}>
          {saving() ? '正在交…' : '交给编排者'}
        </button>
      </form>
      <Show when={saveError()}>
        <p class="px-1 text-xs text-destructive [overflow-wrap:anywhere]">没交上：{saveError()}。字还在框里，可以再交一次</p>
      </Show>
      <Show when={!loadError()} fallback={<p class={cn(card, 'px-4 text-warning')}>{loadError()}</p>}>
        <Show when={items()} fallback={<p class={empty}>读取中…</p>}>
          <Show when={items()!.length} fallback={<p class={empty}>还没有记下的想法</p>}>
            <Show when={open().length}>
              <div class={list}>
                <For each={open()}>{(x) => <Item x={x} />}</For>
              </div>
            </Show>
            <Show when={handled().length}>
              <div class="flex flex-col gap-2">
                <h2 class="flex h-8 items-center gap-2 px-4 text-sm">
                  <span class="font-medium">已处理</span>
                  <span class="text-subtle-foreground tabular-nums">{handled().length}</span>
                </h2>
                <div class={list}>
                  <For each={handled()}>{(x) => <Item x={x} />}</For>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
