import { createMemo, For, Show } from 'solid-js'
import { Progress, ProgressIndicator, ProgressTrack } from '@ui-sdk/solid/progress'
import { agentLetter, agentLine, ASK_WORDS, justHappened, pushedThreads, todaysMoves, waitingOnYou, type Move, type Push, type PushedThread, type WaitingCard } from './home-logic'
import { OKR_WORDS, okrView, taskHref, WINDOW_WORDS, type Agent, type Board } from './logic'
import { clockOf } from './detail-logic'
import { button, cn, empty } from './ui'

const W = WINDOW_WORDS.zh
const O = OKR_WORDS.zh
const WORDS = {
  waiting: '等你',
  noneWaiting: '没有等你的',
  answer: '作答',
  open: '打开',
  bigPicture: '大局',
  today: '今天动了什么',
  quietToday: '今天还没有动静',
  pushed: '在推的事',
  nonePushed: '没有在推的事',
  justHappened: '刚刚发生',
  nothingHappened: '还没有动静',
}
const PUSH_LOOKS: Record<Push, { bar: string; word: string }> = {
  blocked: { bar: 'bg-warning', word: 'text-warning' },
  moving: { bar: 'bg-status-progress', word: 'text-status-progress' },
  idle: { bar: 'bg-border', word: 'text-muted-foreground' },
}
const lane = 'flex min-w-0 flex-col gap-1.5 rounded-2xl bg-muted p-1.5'
const laneHead = 'flex items-baseline gap-2 px-2 pt-1.5 pb-0.5 text-sm font-medium'
const tile = 'flex flex-col gap-2 rounded-xl bg-card p-3 text-sm text-card-foreground shadow-card'
const linkedTile = cn(tile, 'outline-none hover:ring-1 hover:ring-border focus-visible:ring-3 focus-visible:ring-ring/50')
const metaLine = 'flex min-w-0 items-center gap-2 text-xs text-muted-foreground'
const quiet = 'text-muted-foreground'

const nowInSeconds = () => Math.floor(Date.now() / 1000)

export function HomePage(props: { board: Board | null; okr: unknown; okrError: string }) {
  const waiting = createMemo(() => waitingOnYou(props.board))
  const pushed = createMemo(() => pushedThreads(props.board, nowInSeconds()))
  const moves = createMemo(() => todaysMoves(props.board, nowInSeconds()))
  const happened = createMemo(() => justHappened(props.board))
  return (
    <Show when={props.board} fallback={<p class={empty}>{W.loading}</p>}>
      <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <section aria-label={WORDS.waiting} class={lane}>
          <LaneHead name={WORDS.waiting} count={waiting().length} />
          <Show when={waiting().length} fallback={<p class={cn(tile, quiet)}>{WORDS.noneWaiting}</p>}>
            <For each={waiting()}>{(w) => <WaitingTile w={w} />}</For>
          </Show>
        </section>
        <section aria-label={WORDS.bigPicture} class={cn(lane, 'max-md:order-last')}>
          <LaneHead name={WORDS.bigPicture} />
          <BigPicture okr={props.okr} error={props.okrError} />
          <LaneHead name={WORDS.today} />
          <Feed rows={moves()} empty={WORDS.quietToday} />
        </section>
        <section aria-label={WORDS.pushed} class={lane}>
          <LaneHead name={WORDS.pushed} count={pushed().length} />
          <Show when={pushed().length} fallback={<p class={cn(tile, quiet)}>{WORDS.nonePushed}</p>}>
            <For each={pushed()}>{(p) => <PushedTile p={p} />}</For>
          </Show>
          <LaneHead name={WORDS.justHappened} />
          <Feed rows={happened()} empty={WORDS.nothingHappened} whoDid={(r) => agentLine(r.agent, 'worker')} />
        </section>
      </div>
    </Show>
  )
}

function LaneHead(props: { name: string; count?: number }) {
  return (
    <h2 class={laneHead}>
      <span>{props.name}</span>
      <Show when={props.count !== undefined}>
        <span class="font-normal text-muted-foreground tabular-nums">{props.count}</span>
      </Show>
    </h2>
  )
}

function AgentBadge(props: { agent: Agent | null }) {
  return (
    <span aria-hidden="true" class="flex size-5 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground">
      {agentLetter(props.agent)}
    </span>
  )
}

function WaitingTile(props: { w: WaitingCard }) {
  const who = () => agentLine(props.w.agent, 'model') + ' · ' + props.w.id
  return (
    <article class={tile}>
      <div class={metaLine}>
        <AgentBadge agent={props.w.agent} />
        <span title={who()} class="min-w-0 flex-1 truncate tabular-nums">{who()}</span>
        <span class="inline-flex h-5 shrink-0 items-center rounded-md bg-warning/15 px-1.5 font-medium text-warning">{ASK_WORDS[props.w.ask]}</span>
      </div>
      <p title={props.w.question} class="line-clamp-2 font-medium [overflow-wrap:anywhere]">{props.w.question}</p>
      <div class="flex gap-2">
        <Show when={props.w.answerable}>
          <a class={button('default', 'sm')} href="#decide">{WORDS.answer}</a>
        </Show>
        <a class={button('dismiss', 'sm')} href={taskHref(props.w.id)}>{WORDS.open}</a>
      </div>
    </article>
  )
}

function PushedTile(props: { p: PushedThread }) {
  const look = () => PUSH_LOOKS[props.p.push]
  const who = () => agentLine(props.p.agent, 'model', 'worker')
  return (
    <a href={taskHref(props.p.id)} class={cn(linkedTile, 'relative overflow-hidden pt-3.5')}>
      <span aria-hidden="true" class={cn('absolute inset-x-0 top-0 h-0.75', look().bar)} />
      <span class="flex min-w-0 items-baseline gap-2">
        <span title={props.p.title} class="min-w-0 flex-1 truncate font-medium">{props.p.title}</span>
        <span class={cn('shrink-0 text-xs font-medium', look().word)}>{props.p.word}</span>
      </span>
      <Show when={props.p.note}>{(note) => <span title={note()} class={cn('truncate', quiet)}>{note()}</span>}</Show>
      <span class={metaLine}>
        <AgentBadge agent={props.p.agent} />
        <span title={who()} class="min-w-0 truncate">{who()}</span>
      </span>
    </a>
  )
}

function BigPicture(props: { okr: unknown; error: string }) {
  const view = createMemo(() => okrView(props.okr))
  return (
    <div class={tile}>
      <Show when={!props.error} fallback={<p class="text-warning [overflow-wrap:anywhere]">{props.error}</p>}>
        <Show when={props.okr} fallback={<p class={quiet}>{W.loading}</p>}>
          <Show when={view()} fallback={<p class={quiet}>{O.noObjective}</p>}>
            {(v) => (
              <For each={v().objectives}>
                {(o) => (
                  <div class="flex flex-col gap-1.5">
                    <div class="flex min-w-0 items-baseline gap-2">
                      <span title={o.name} class="min-w-0 flex-1 truncate">{o.name}</span>
                      <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{o.met}/{o.total}</span>
                    </div>
                    <Progress value={o.total ? Math.round((o.met / o.total) * 100) : 0} aria-label={o.name}>
                      <ProgressTrack class="h-1.5 overflow-hidden rounded-full bg-muted">
                        <ProgressIndicator class="h-full rounded-full bg-brand" />
                      </ProgressTrack>
                    </Progress>
                  </div>
                )}
              </For>
            )}
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function Feed<Row extends Move>(props: { rows: Row[]; empty: string; whoDid?: (row: Row) => string }) {
  return (
    <div class={cn(tile, 'gap-0 p-1.5')}>
      <Show when={props.rows.length} fallback={<p class={cn('px-1.5 py-1', quiet)}>{props.empty}</p>}>
        <For each={props.rows}>
          {(r) => (
            <a href={taskHref(r.task)} class="flex min-w-0 items-baseline gap-3 rounded-lg px-1.5 py-1 outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
              <span class="shrink-0 text-xs text-subtle-foreground tabular-nums">{clockOf(r.at)}</span>
              <span title={r.text} class="min-w-0 truncate">
                <Show when={props.whoDid}>{(whoDid) => <span class={quiet}>{whoDid()(r)} · </span>}</Show>
                {r.text}
              </span>
            </a>
          )}
        </For>
      </Show>
    </div>
  )
}
