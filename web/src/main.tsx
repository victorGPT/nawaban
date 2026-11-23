import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { render } from '@solidjs/web'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/solid/tabs'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/solid/collapsible'
import { Progress, ProgressIndicator, ProgressTrack } from '@ui-sdk/solid/progress'
import {
  foldKey, krFill, linkOf, OKR_WORDS, okrReadingOfFailure, okrView, type KrRow, type ObjectiveRow, localMonthDayTime, pendingCount, projectShown, routeOf, sinceLabel, summaryOf, taskGroups, taskHref, taskSections,
  WINDOW_WORDS, type Board, type Item, type Project, type Route, type Tab,
} from './logic'
import { Inbox } from './inbox'
import { DecidePage } from './Decide'
import { badge, button, card, cardList, cn, empty, Icon, selectTrigger, sectionHead, type BadgeVariant } from './ui'
import type { IconName } from './icons'
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '@fontsource/geist-mono/400.css'
import './index.css'

const TOKEN_KEY = 'nawaban-web-token'
const PROJECT_KEY = 'nawaban-web-project'
const FOLDS_KEY = 'nawaban-web-folds'
const SHOWN_ALL_KEY = 'nawaban-web-shown-all'
const RECONNECT_MS = 3000
const W = WINDOW_WORDS.zh
const O = OKR_WORDS.zh
const TAB_NAMES: Record<Tab, string> = { decide: W.tabs.decide, okr: W.tabs.okr, tasks: W.tabs.tasks, inbox: '收件箱' }
const TAB_ICONS: Record<Tab, IconName> = { decide: 'CircleCheck', okr: 'Target', tasks: 'ListTodo', inbox: 'Inbox' }
const STATUS_NAMES: Record<string, string> = { open: '待办', in_progress: '进行中', done: '已完成', cancelled: '已取消' }
const STATUS_BADGES: Record<string, BadgeVariant> = { open: 'outline', in_progress: 'progress', done: 'success', cancelled: 'muted' }
const STATE_ICONS: Record<Item['state'], { icon: IconName; tone: string }> = {
  todo: { icon: 'Circle', tone: 'text-status-todo' },
  working: { icon: 'CircleDashed', tone: 'text-status-progress' },
  stopped: { icon: 'CircleMinus', tone: 'text-warning' },
  done: { icon: 'CircleCheck', tone: 'text-status-done' },
}

type Ref = { id: string; title: string; status: string }
type Event = { kind: string; body: string; author: string; at: number }
type Detail = {
  id: string; title: string; body: string; status: string; project: string; session: string | null; created_at: number
  parent: Ref | null; children: Ref[]; blocked_by: Ref[]; dependents: Ref[]
  latest_note: Event | null; decisions: Event[]; links: Event[]; events: Event[]
}

function routeTakingTheTokenIntoThisTab() {
  const { route, token, hashWithoutToken } = routeOf(location.hash)
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token)
    history.replaceState(null, '', location.pathname + location.search + hashWithoutToken)
  }
  return route
}

const firstRoute = routeTakingTheTokenIntoThisTab()
const headers = { authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) ?? ''}` }

class Refusal extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const read = <T,>(view: string): Promise<T> =>
  fetch(`/api/nawaban/${view}`, { headers }).then(async (r) => {
    if (r.ok) return r.json()
    if (r.status === 401) throw new Refusal('用 nawaban web 打开这一页', r.status)
    const said = await r.json().then((b: { error?: string }) => b.error, () => null)
    throw new Refusal(said || `看板答 ${r.status}`, r.status)
  })

async function onEachChange(then: () => void) {
  for (;;) {
    try {
      const r = await fetch('/api/nawaban/changes', { headers }).finally(then)
      if (!r.ok) throw new Error(`看板答 ${r.status}`)
      const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader()
      let unfinished = ''
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        const frames = (unfinished + chunk.value).split('\n\n')
        unfinished = frames.pop()!
        if (frames.some((f) => f.startsWith('data:'))) then()
      }
    } catch {}
    await new Promise((done) => setTimeout(done, RECONNECT_MS))
  }
}

const stored = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback
  } catch {
    return fallback
  }
}
const keep = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

const nowInSeconds = () => Math.floor(Date.now() / 1000)
const when = (at: number) => localMonthDayTime(at * 1000)

function App() {
  const [route, setRoute] = createSignal<Route>(firstRoute)
  const [picked, setPicked] = createSignal<string | null>(stored(PROJECT_KEY, null))
  const [projects, setProjects] = createSignal<Project[]>([])
  const [board, setBoard] = createSignal<Board | null>(null)
  const [detail, setDetail] = createSignal<Detail | null>(null)
  const [detailError, setDetailError] = createSignal('')
  const [error, setError] = createSignal('')
  const [okr, setOkr] = createSignal<{ of: string; reading: unknown; error: string } | null>(null)
  const [changes, setChanges] = createSignal(0)
  const [folds, setFolds] = createSignal<Record<string, boolean>>(stored(FOLDS_KEY, {}))
  const [shownAll, setShownAll] = createSignal<Record<string, boolean>>(stored(SHOWN_ALL_KEY, {}))

  window.addEventListener('hashchange', () => setRoute(routeOf(location.hash).route))
  void onEachChange(() => setChanges((n) => n + 1))

  let reads = 0
  type OkrFlight = { of: string; read: ReturnType<typeof readOkr> }
  let okrFlight: OkrFlight | null = null
  let okrShown: OkrFlight | null = null
  const readOkr = (name: string) =>
    read(`okr?project=${encodeURIComponent(name)}`).then(
      (x) => [x, ''] as const,
      (e: Error) => [okrReadingOfFailure(e), okrReadingOfFailure(e) ? '' : e.message] as const,
    )
  const okrReadSharedWhileInFlight = (name: string) => {
    if (okrFlight?.of === name) return okrFlight
    const flight: OkrFlight = { of: name, read: readOkr(name).finally(() => okrFlight === flight && (okrFlight = null)) }
    okrFlight = flight
    return flight
  }
  async function load(r: Route, want: string | null) {
    const mine = ++reads
    try {
      const list = (await read<{ projects: Project[] }>('projects')).projects
      const project = projectShown(list, want)
      if (project && r.tab === 'okr' && mine === reads) {
        const flight = (okrShown = okrReadSharedWhileInFlight(project))
        void flight.read.then((o) => okrShown === flight && setOkr({ of: project, reading: o[0], error: o[1] }))
      }
      const [b, d] = await Promise.all([
        project ? read<Board>(`board?project=${encodeURIComponent(project)}`) : null,
        r.task ? read<Detail>(`task/${encodeURIComponent(r.task)}`).then((x) => [x, ''] as const, (e: Error) => [null, e.message] as const) : ([null, ''] as const),
      ])
      if (mine !== reads) return
      setProjects(list)
      setBoard(b)
      setDetail(d[0])
      setDetailError(d[1])
      setError('')
      if (project !== want) setPicked(project)
    } catch (e) {
      if (mine === reads) setError((e as Error).message)
    }
  }
  createEffect(
    () => ({ r: route(), p: picked(), n: changes() }),
    ({ r, p }) => void load(r, p),
  )

  const groups = createMemo(() => taskGroups(board(), nowInSeconds()))
  const sections = createMemo(() => taskSections(groups(), { folds: folds(), project: picked(), shownAll: shownAll() }))
  const summary = createMemo(() => (board() ? summaryOf(groups(), pendingCount(board())) : ''))

  const pick = (name: string) => {
    keep(PROJECT_KEY, name)
    setPicked(name)
  }
  const toggle = (setter: typeof setFolds, key: string, storeKey: string, value: boolean) =>
    setter((all) => {
      const next = { ...all, [key]: value }
      keep(storeKey, next)
      return next
    })

  return (
    <Tabs
      value={route().tab}
      onValueChange={(v) => (location.hash = '#' + v)}
      class="flex h-svh min-h-0 overflow-hidden bg-background text-foreground max-md:h-auto max-md:min-h-svh max-md:flex-col max-md:overflow-visible"
    >
      <aside class="flex w-52 shrink-0 flex-col gap-3 border-r border-sidebar-border bg-sidebar px-3 text-sidebar-foreground max-md:w-full max-md:border-r-0 max-md:border-b max-md:pb-3">
        <div class="flex h-15.5 items-center gap-2 px-1 max-md:h-12">
          <span class="flex size-7 items-center justify-center rounded-lg bg-brand text-primary-foreground">
            <Icon name="SquareKanban" />
          </span>
          <span class="text-base font-semibold">nawaban</span>
        </div>
        <label class="relative flex">
          <select class={selectTrigger} aria-label="项目" value={picked() ?? ''} onChange={(e) => pick(e.currentTarget.value)}>
            <For each={projects()}>{(p) => <option value={p.name} selected={p.name === picked()}>{p.name}</option>}</For>
          </select>
          <Icon name="ChevronsUpDown" class="pointer-events-none absolute top-2 right-2 text-muted-foreground" />
        </label>
        <TabsList
          aria-label="视图"
          class="flex flex-col gap-0 max-md:h-8 max-md:flex-row max-md:gap-0 max-md:rounded-lg max-md:bg-muted max-md:p-[3px] max-md:text-muted-foreground"
        >
          <For each={Object.keys(TAB_NAMES) as Tab[]}>
            {(t) => (
              <TabsTab
                value={t}
                class="flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-selected:bg-sidebar-accent data-selected:font-medium data-selected:text-sidebar-accent-foreground max-md:h-full max-md:flex-1 max-md:justify-center max-md:rounded-lg max-md:border max-md:border-transparent max-md:px-2 max-md:py-0.5 max-md:font-medium max-md:text-foreground/60 max-md:hover:bg-transparent max-md:hover:text-foreground max-md:data-selected:bg-card max-md:data-selected:text-foreground max-md:data-selected:shadow-control"
              >
                <Icon name={TAB_ICONS[t]} class="max-md:hidden" />
                <span class="truncate">{TAB_NAMES[t]}</span>
              </TabsTab>
            )}
          </For>
        </TabsList>
      </aside>
      <div class="flex min-w-0 flex-1 flex-col overflow-hidden max-md:overflow-visible">
        <header class="flex h-15.5 shrink-0 items-center gap-2 border-b border-border px-4 max-md:h-auto max-md:flex-wrap max-md:py-3">
          <h1 class="flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
            <Icon name={TAB_ICONS[route().tab]} class="text-muted-foreground" />
            {TAB_NAMES[route().tab]}
          </h1>
          <span class="ml-auto min-w-0 truncate text-muted-foreground max-md:ml-0 max-md:basis-full max-md:whitespace-normal">{summary()}</span>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="flex w-full flex-col gap-4 p-4">
            <Show when={!error()} fallback={<p class={cn(card, 'px-4 text-warning')}>{error()}</p>}>
              <TabsPanel value="decide" class="outline-none"><DecidePage board={board()} project={picked()} headers={headers} /></TabsPanel>
              <TabsPanel value="okr" class="outline-none"><OkrPage okr={okr()?.of === picked() ? okr()!.reading : null} error={okr()?.of === picked() ? okr()!.error : ''} /></TabsPanel>
              <TabsPanel value="tasks" class="outline-none">
                <Show when={route().task} fallback={
                  <Show when={board()} fallback={<p class={empty}>{W.loading}</p>}>
                    <Show when={sections().length} fallback={<p class={empty}>这个项目还没有任务</p>}>
                      <div class="flex flex-col gap-6">
                        <For each={sections()}>
                          {(s) => (
                            <Collapsible class="flex flex-col gap-2" open={s.open} onOpenChange={(open) => toggle(setFolds, foldKey(picked(), s.group), FOLDS_KEY, open)}>
                              <CollapsibleTrigger class={cn(sectionHead, 'group w-full rounded-lg text-left outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50')}>
                                <Icon name={STATE_ICONS[s.group as Item['state']].icon} class={STATE_ICONS[s.group as Item['state']].tone} />
                                <span class="font-medium">{W.groups[s.group as keyof typeof W.groups]}</span>
                                <span class="text-subtle-foreground tabular-nums">{s.count}</span>
                                <Icon name="ChevronDown" class="ml-auto -rotate-90 text-muted-foreground transition-transform group-data-open:rotate-0" />
                              </CollapsibleTrigger>
                              <CollapsiblePanel class={cardList}>
                                <For each={s.items as Item[]}>{(x) => <TaskRow item={x} />}</For>
                                <Show when={s.more}>
                                  {(more) => (
                                    <button type="button" class={cn(button('ghost'), 'w-full rounded-none text-muted-foreground')} onClick={() => toggle(setShownAll, foldKey(picked(), s.group), SHOWN_ALL_KEY, !!more().hidden)}>
                                      {more().hidden ? W.more(more().hidden) : W.less}
                                    </button>
                                  )}
                                </Show>
                              </CollapsiblePanel>
                            </Collapsible>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                }>
                  {(key) => <TaskDetail key={key()} detail={detail()} error={detailError()} />}
                </Show>
              </TabsPanel>
              <TabsPanel value="inbox" class="outline-none">
                <Show when={picked()} fallback={<p class={empty}>{W.loading}</p>}>
                  {(p) => <Inbox project={p()} headers={headers} changes={changes()} taskHref={taskHref} />}
                </Show>
              </TabsPanel>
            </Show>
          </div>
        </div>
      </div>
    </Tabs>
  )
}

function TaskRow(props: { item: Item }) {
  const look = () => STATE_ICONS[props.item.state]
  const quiet = () => props.item.state === 'done'
  return (
    <a class="flex flex-col gap-1 px-4 py-2.5 outline-none hover:bg-muted/50 focus-visible:bg-muted/50" href={taskHref(props.item.id)}>
      <span class="flex min-w-0 items-center gap-2">
        <Icon name={look().icon} class={look().tone} />
        <span class={cn('min-w-0 flex-1 truncate font-medium', quiet() && 'text-muted-foreground')}>{props.item.title}</span>
        <Show when={props.item.spec}>{(spec) => <span class={badge('secondary')}>{spec().done}/{spec().total}</span>}</Show>
        <span class="shrink-0 text-xs text-subtle-foreground tabular-nums">{sinceLabel(props.item, nowInSeconds(), 'zh')}</span>
      </span>
      <span class="flex min-w-0 items-center gap-2 pl-6 text-xs text-muted-foreground">
        <span class="shrink-0 text-subtle-foreground tabular-nums">{props.item.id}</span>
        <Show when={props.item.note}>{(note) => <span class="min-w-0 truncate">{note()}</span>}</Show>
      </span>
    </a>
  )
}

function RefList(props: { label: string; refs: Ref[] }) {
  return (
    <Show when={props.refs.length}>
      <div class="flex gap-3 text-sm">
        <span class="w-10 shrink-0 text-muted-foreground">{props.label}</span>
        <span class="flex min-w-0 flex-col gap-1">
          <For each={props.refs}>
            {(r) => (
              <a href={taskHref(r.id)} class={cn('truncate hover:underline', r.status === 'done' ? 'text-subtle-foreground' : 'text-foreground')}>
                <span class="text-subtle-foreground tabular-nums">{r.id}</span> {r.title}
              </a>
            )}
          </For>
        </span>
      </div>
    </Show>
  )
}

function TaskDetail(props: { key: string; detail: Detail | null; error: string }) {
  const d = () => (props.detail?.id === props.key ? props.detail : null)
  return (
    <article class="flex flex-col gap-6">
      <a href="#tasks" class={cn(button('ghost', 'sm'), 'self-start text-muted-foreground')}>
        <Icon name="ChevronLeft" />
        {W.tabs.tasks}
      </a>
      <Show when={d()} fallback={<p class={empty}>{props.error || W.loading}</p>}>
        {(t) => (
          <>
            <section class={cn(card, 'px-4')}>
              <div class="flex flex-col gap-1">
                <h2 class="text-lg leading-snug font-medium">{t().title}</h2>
                <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span class="tabular-nums">{t().id}</span>
                  <span class={badge(STATUS_BADGES[t().status] ?? 'outline')}>{STATUS_NAMES[t().status] ?? t().status}</span>
                  <Show when={t().session}>{(s) => <span>{s()}</span>}</Show>
                  <span class="text-subtle-foreground tabular-nums">{when(t().created_at)}</span>
                </div>
              </div>
              <Show when={t().body} fallback={<p class="text-subtle-foreground">没有正文</p>}>
                <div class="border-t border-border pt-4 whitespace-pre-wrap [overflow-wrap:anywhere]">{t().body}</div>
              </Show>
              <RefList label="上级" refs={t().parent ? [t().parent!] : []} />
              <RefList label="子票" refs={t().children} />
              <RefList label="被挡" refs={t().blocked_by} />
              <RefList label="挡着" refs={t().dependents} />
            </section>
            <Part title={W.facts.note} empty="还没有进展" items={t().latest_note ? [t().latest_note!] : []} />
            <Part title="决策记录" empty="没有决策记录" items={t().decisions} />
            <section class="flex flex-col gap-2">
              <h2 class={sectionHead}><span class="font-medium">链接</span></h2>
              <Show when={t().links.length} fallback={<p class={empty}>没有链接</p>}>
                <div class={cardList}>
                  <For each={t().links}>
                    {(e) => {
                      const link = linkOf(e.body)
                      return (
                        <div class="flex min-w-0 items-center gap-2 px-4 py-2.5">
                          <span class={badge('outline')}>{link.kind || '链接'}</span>
                          <Show when={link.href} fallback={<span class="min-w-0 [overflow-wrap:anywhere]">{link.ref}</span>}>
                            {(href) => <a class="min-w-0 text-primary underline-offset-4 [overflow-wrap:anywhere] hover:underline" href={href()} target="_blank" rel="noreferrer">{link.ref}</a>}
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </section>
            <Part title="事件流" empty="还没有事件" items={t().events} tagged />
          </>
        )}
      </Show>
    </article>
  )
}

const KIND_NAMES: Record<string, string> = { note: '进展', decision: '决策', link: '链接', ask: '待决', resolve: '已决', dispatch: '派工' }
const KIND_BADGES: Record<string, BadgeVariant> = { note: 'secondary', decision: 'success', resolve: 'success', link: 'outline', dispatch: 'progress', ask: 'warning' }

function Part(props: { title: string; empty: string; items: Event[]; tagged?: boolean }) {
  return (
    <section class="flex flex-col gap-2">
      <h2 class={sectionHead}><span class="font-medium">{props.title}</span></h2>
      <Show when={props.items.length} fallback={<p class={empty}>{props.empty}</p>}>
        <div class={cardList}>
          <For each={props.items}>
            {(e) => (
              <div class="flex flex-col gap-1 px-4 py-2.5">
                <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <Show when={props.tagged}>
                    <span class={badge(KIND_BADGES[e.kind] ?? 'secondary')}>{KIND_NAMES[e.kind] ?? e.kind}</span>
                  </Show>
                  <span class="truncate">{e.author}</span>
                  <span class="ml-auto shrink-0 text-subtle-foreground tabular-nums">{when(e.at)}</span>
                </div>
                <div class="whitespace-pre-wrap [overflow-wrap:anywhere]">{e.body}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

render(() => <App />, document.getElementById('root')!)

const KR_TONES: Record<KrRow['status'], { text: string; bar: string }> = {
  met: { text: 'text-status-done', bar: 'bg-status-done' },
  missed: { text: 'text-destructive', bar: 'bg-destructive' },
  stale: { text: 'text-warning', bar: 'bg-warning' },
  untested: { text: 'text-subtle-foreground', bar: 'bg-status-todo' },
}
const STANDING_TONES: Record<ObjectiveRow['standing'], string> = { met: 'text-status-done', missed: 'text-destructive', unsure: 'text-muted-foreground' }

function OkrPage(props: { okr: unknown; error: string }) {
  const view = createMemo(() => okrView(props.okr))
  return (
    <Show when={!props.error} fallback={<p class={cn(card, 'px-4 text-warning')}>{props.error}</p>}>
      <Show when={props.okr} fallback={<p class={empty}>{W.loading}</p>}>
        <Show when={view()} fallback={<p class={empty}>{O.noObjective}</p>}>
          {(v) => (
            <div class="flex flex-col gap-4">
              <p class="px-1 text-muted-foreground">{O.tally(v().met, v().total, v().measured)}</p>
              <For each={v().objectives}>{(o) => <ObjectiveCard o={o} />}</For>
            </div>
          )}
        </Show>
      </Show>
    </Show>
  )
}

const foldTrigger = 'group flex w-full items-center gap-2 rounded-lg px-4 py-2 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50'

function ObjectiveCard(props: { o: ObjectiveRow }) {
  const o = () => props.o
  return (
    <section class={cn(card, 'gap-2 py-2')}>
      <Show
        when={o().standing !== 'met'}
        fallback={
          <Collapsible>
            <CollapsibleTrigger class={cn(foldTrigger, 'py-2.5')}>
              <Icon name="ChevronDown" class="-rotate-90 text-muted-foreground transition-transform group-data-open:rotate-0" />
              <span class="min-w-0 flex-1 truncate text-muted-foreground">{o().name}</span>
              <span class={badge('success')}>{O.allMet} {o().met}/{o().total}</span>
            </CollapsibleTrigger>
            <CollapsiblePanel class="flex flex-col"><For each={o().metKrs}>{(k) => <KrLine k={k} quiet />}</For></CollapsiblePanel>
          </Collapsible>
        }
      >
        <header class="flex items-baseline gap-3 px-4 pt-2">
          <h2 class="min-w-0 flex-1 truncate text-base leading-snug font-medium">{o().name}</h2>
          <span class={cn('shrink-0 text-sm font-medium tabular-nums', STANDING_TONES[o().standing])}>{o().met}/{o().total}</span>
        </header>
        <div class="flex flex-col"><For each={o().krs}>{(k) => <KrLine k={k} />}</For></div>
        <Fold label={O.untestedFolded(o().untestedKrs.length)} krs={o().untestedKrs} />
        <Fold label={O.metFolded(o().metKrs.length)} krs={o().metKrs} />
      </Show>
    </section>
  )
}

function Fold(props: { label: string; krs: KrRow[] }) {
  return (
    <Show when={props.krs.length}>
      <Collapsible class="border-t border-border pt-1">
        <CollapsibleTrigger class={cn(foldTrigger, 'text-muted-foreground')}>
          <Icon name="ChevronDown" class="-rotate-90 transition-transform group-data-open:rotate-0" />
          {props.label}
        </CollapsibleTrigger>
        <CollapsiblePanel class="flex flex-col"><For each={props.krs}>{(k) => <KrLine k={k} quiet />}</For></CollapsiblePanel>
      </Collapsible>
    </Show>
  )
}

function KrLine(props: { k: KrRow; quiet?: boolean }) {
  const k = () => props.k
  const fill = () => krFill(k())
  const tone = () => KR_TONES[k().status]
  return (
    <div class="flex flex-col gap-1.5 px-4 py-2.5">
      <div class={cn('truncate', props.quiet || k().status === 'untested' ? 'text-muted-foreground' : 'text-foreground')}>{k().name}</div>
      <Show when={fill() != null}>
        <Progress value={Math.round(fill()! * 100)} aria-label={k().name}>
          <ProgressTrack class="h-1.5 overflow-hidden rounded-full bg-muted">
            <ProgressIndicator class={cn('h-full rounded-full', tone().bar)} />
          </ProgressTrack>
        </Progress>
      </Show>
      <div class="flex flex-wrap items-baseline gap-1 text-xs text-subtle-foreground tabular-nums">
        <Show when={k().measured} fallback={<span>{O.status.untested} / {O.target} {k().target}</span>}>
          <span class={cn(props.quiet ? 'text-sm text-muted-foreground' : 'text-sm font-medium', !props.quiet && (k().status === 'missed' ? 'text-destructive' : 'text-foreground'))}>{k().value}</span>
          <span>/ {O.target} {k().target}</span>
          <Show when={k().gap}>
            <span>· {O.variance}</span>
            <span class={tone().text}>{k().gap}</span>
          </Show>
          <span>·</span>
          <span class={tone().text}>{O.status[k().status]}</span>
          <Show when={k().day}><span>· {O.asOfShort} {k().day}</span></Show>
        </Show>
      </div>
    </div>
  )
}
