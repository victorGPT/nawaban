import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Radio, RadioGroup } from '@ui-sdk/solid/radio'
import { answersStillAbout, decisionCards, handedText, REPLIES, type DecideBoard, type DecisionCard, type FetchedAnswers, type Reply, type WebAnswer } from './decide-logic'
import { badge, button, card, cn, empty } from './ui'

const WORDS = {
  chip: '选一项',
  decision: '决策事项',
  kr: '关联 KR',
  context: '背景',
  options: '备选方案',
  rec: '建议',
  settle: '就这么定',
  unclear: '背景不够',
  decided: '已定，请核实',
  sending: '正在交给编排者…',
  nothing: '没有等你决定的待决',
  loading: '读取中…',
  failed: (why: string) => `没交上：${why}`,
}

const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })

type Props = { board: DecideBoard | null; project: string | null; headers: Record<string, string> }

export function DecidePage(props: Props) {
  const [fetched, setFetched] = createSignal<FetchedAnswers>({ board: null, answers: [] })
  const scope = () => (props.project ? `?project=${encodeURIComponent(props.project)}` : '')
  createEffect(
    () => ({ s: scope(), board: props.board }),
    ({ s, board }) =>
      void fetch(`/api/nawaban/answers${s}`, { headers: props.headers })
        .then((r) => (r.ok ? r.json() : null))
        .then((b: { answers: WebAnswer[] } | null) => b && board === props.board && setFetched({ board, answers: b.answers }), () => {}),
  )
  const cards = createMemo(() => decisionCards(props.board, answersStillAbout(props.board, fetched())))
  const handedWhileTheBoardStays = () => {
    const board = props.board
    return (a: WebAnswer) => board === props.board && setFetched((f) => ({ board, answers: [...answersStillAbout(board, f).filter((x) => x.task !== a.task), a] }))
  }
  const [picked, setPicked] = createSignal<Record<string, string>>({})
  const markOf = (c: DecisionCard) => `${c.id}@${c.at}`
  return (
    <section class="flex flex-col gap-4">
      <Show when={props.board} fallback={<p class={empty}>{WORDS.loading}</p>}>
        <Show when={cards().length} fallback={<p class={empty}>{WORDS.nothing}</p>}>
          <For each={cards()}>{(c) => (
              <DecisionCardView
                card={c}
                headers={props.headers}
                scope={scope()}
                handedWhileTheBoardStays={handedWhileTheBoardStays}
                option={picked()[markOf(c)] ?? ''}
                onPick={(option) => setPicked((all) => ({ ...all, [markOf(c)]: option }))}
              />
            )}</For>
        </Show>
      </Show>
    </section>
  )
}

type CardProps = { card: DecisionCard; headers: Record<string, string>; scope: string; handedWhileTheBoardStays: () => (a: WebAnswer) => void; option: string; onPick: (option: string) => void }

function DecisionCardView(props: CardProps) {
  const option = () => props.option
  const [sending, setSending] = createSignal(false)
  const [failed, setFailed] = createSignal('')
  const id = () => props.card.id
  async function send(reply: Reply) {
    const handed = props.handedWhileTheBoardStays()
    setSending(true)
    setFailed('')
    try {
      const r = await fetch(`/api/nawaban/answer/${encodeURIComponent(id())}${props.scope}`, {
        method: 'POST',
        headers: { ...props.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ ask: props.card.ask, ...reply }),
      })
      const said = await r.json().catch(() => null)
      if (!r.ok) throw new Error(said?.error ?? `看板答 ${r.status}`)
      handed(said as WebAnswer)
    } catch (e) {
      setFailed((e as Error).message)
    } finally {
      setSending(false)
    }
  }
  return (
    <article class={cn(card, 'gap-4 px-4')} data-handed={props.card.handed ? '' : undefined}>
      <header class="flex flex-col gap-1">
        <div class="flex items-start gap-3">
          <h2 class="min-w-0 flex-1 text-base leading-snug font-medium [overflow-wrap:anywhere]">{props.card.headline}</h2>
          <span class={badge('warning')}>{WORDS.chip}</span>
        </div>
        <p class="text-xs text-muted-foreground tabular-nums [overflow-wrap:anywhere]">{[id(), props.card.kr, day(props.card.at)].join(' · ')}</p>
      </header>
      <Show when={props.card.more}>{(more) => <Fact label={WORDS.decision} text={more()} strong />}</Show>
      <Fact label={WORDS.kr} text={props.card.kr} />
      <Fact label={WORDS.context} text={props.card.context} />
      <div class="flex flex-col gap-1.5">
        <span class="text-xs text-muted-foreground">{WORDS.options}</span>
        <RadioGroup class="flex flex-col gap-2 outline-none" aria-label={WORDS.options} value={option()} onValueChange={(v) => props.onPick(v ?? '')} disabled={sending()}>
          <For each={props.card.options}>
            {(o) => (
              <Radio
                value={o.text}
                class="flex cursor-pointer flex-col items-stretch gap-0.5 rounded-lg border border-border bg-card px-3 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 aria-checked:border-ring aria-checked:ring-1 aria-checked:ring-ring aria-disabled:cursor-default aria-disabled:opacity-50"
              >
                <span class="[overflow-wrap:anywhere]">
                  {o.key} · {o.text}
                </span>
                <Show when={o.note}>
                  <span class="text-xs text-muted-foreground [overflow-wrap:anywhere]">{o.note}</span>
                </Show>
              </Radio>
            )}
          </For>
        </RadioGroup>
      </div>
      <div class="flex items-baseline gap-3">
        <span class="shrink-0 text-xs text-muted-foreground">{WORDS.rec}</span>
        <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{props.card.rec}</span>
      </div>
      <Show when={props.card.handed}>{(a) => <p class="text-xs text-status-done" role="status">{handedText(a())}</p>}</Show>
      <Show when={failed()}>{(why) => <p class="text-xs text-destructive [overflow-wrap:anywhere]" role="alert">{WORDS.failed(why())}</p>}</Show>
      <Show when={sending()}>
        <p class="text-xs text-muted-foreground">{WORDS.sending}</p>
      </Show>
      <div class="flex flex-wrap gap-2 border-t border-border pt-4">
        <button type="button" class={button()} disabled={sending() || !option()} onClick={() => send(REPLIES.pick(option()))}>
          {WORDS.settle}
        </button>
        <button type="button" class={button('dismiss')} disabled={sending()} onClick={() => send(REPLIES.unclear)}>
          {WORDS.unclear}
        </button>
        <button type="button" class={button('dismiss')} disabled={sending()} onClick={() => send(REPLIES.decided)}>
          {WORDS.decided}
        </button>
      </div>
    </article>
  )
}

function Fact(props: { label: string; text: string; strong?: boolean }) {
  return (
    <div class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">{props.label}</span>
      <span class={cn('whitespace-pre-wrap [overflow-wrap:anywhere]', props.strong ? 'text-foreground' : 'text-muted-foreground')}>{props.text}</span>
    </div>
  )
}
