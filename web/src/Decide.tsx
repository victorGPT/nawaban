import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Radio, RadioGroup } from '@ui-sdk/solid/radio'
import { answersStillAbout, decisionCards, handedText, REPLIES, type DecideBoard, type DecisionCard, type FetchedAnswers, type Reply, type WebAnswer } from './decide-logic'
import './decide.css'

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
    <section class="decide">
      <Show when={props.board} fallback={<p class="quiet">{WORDS.loading}</p>}>
        <Show when={cards().length} fallback={<p class="quiet">{WORDS.nothing}</p>}>
          <For each={cards()}>{(c) => (
              <DecisionCardView
                card={c}
                headers={props.headers}
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

type CardProps = { card: DecisionCard; headers: Record<string, string>; handedWhileTheBoardStays: () => (a: WebAnswer) => void; option: string; onPick: (option: string) => void }

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
      const r = await fetch(`/api/nawaban/answer/${encodeURIComponent(id())}`, {
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
    <article class="decision" data-handed={props.card.handed ? '' : undefined}>
      <header class="decision-head">
        <span class="decision-title">{props.card.decision.split('\n')[0]}</span>
        <span class="decision-chip">{WORDS.chip}</span>
      </header>
      <p class="decision-sub">{[id(), props.card.kr, day(props.card.at)].join(' · ')}</p>
      <div class="decision-rule" />
      <Fact label={WORDS.decision} text={props.card.decision} strong />
      <Fact label={WORDS.kr} text={props.card.kr} />
      <Fact label={WORDS.context} text={props.card.context} />
      <div class="decision-fact">
        <span class="decision-fact-label">{WORDS.options}</span>
        <RadioGroup class="options" aria-label={WORDS.options} value={option()} onValueChange={(v) => props.onPick(v ?? '')} disabled={sending()}>
          <For each={props.card.options}>
            {(o) => (
              <Radio value={o.text} class="option">
                <span class="option-text">
                  {o.key} · {o.text}
                </span>
                <Show when={o.note}>
                  <span class="option-note">{o.note}</span>
                </Show>
              </Radio>
            )}
          </For>
        </RadioGroup>
      </div>
      <div class="decision-rec">
        <span class="decision-fact-label">{WORDS.rec}</span>
        <span class="decision-rec-text">{props.card.rec}</span>
      </div>
      <Show when={props.card.handed}>{(a) => <p class="handed" role="status">{handedText(a())}</p>}</Show>
      <Show when={failed()}>{(why) => <p class="failed" role="alert">{WORDS.failed(why())}</p>}</Show>
      <Show when={sending()}>
        <p class="quiet">{WORDS.sending}</p>
      </Show>
      <div class="actions">
        <button type="button" class="action primary" disabled={sending() || !option()} onClick={() => send(REPLIES.pick(option()))}>
          {WORDS.settle}
        </button>
        <button type="button" class="action" disabled={sending()} onClick={() => send(REPLIES.unclear)}>
          {WORDS.unclear}
        </button>
        <button type="button" class="action" disabled={sending()} onClick={() => send(REPLIES.decided)}>
          {WORDS.decided}
        </button>
      </div>
    </article>
  )
}

function Fact(props: { label: string; text: string; strong?: boolean }) {
  return (
    <div class="decision-fact">
      <span class="decision-fact-label">{props.label}</span>
      <span class={props.strong ? 'decision-fact-text strong' : 'decision-fact-text'}>{props.text}</span>
    </div>
  )
}
