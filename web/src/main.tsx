import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { render, type JSX } from '@solidjs/web'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/solid/tabs'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/solid/collapsible'
import { Progress, ProgressIndicator, ProgressTrack } from '@ui-sdk/solid/progress'
import {
  boardColumns, boardTaskOf, foldKey, krFill, OKR_WORDS, okrReadingOfFailure, okrView, type KrRow, type ObjectiveRow, localMonthDayTime, projectShown, routeOf, sinceLabel, summaryOf, taskGroups, taskHref, taskSections,
  WINDOW_WORDS, type Board, type BoardTask, type Item, type Project, type Route, type Tab,
} from './logic'
import { clockOf, detailView, stampOf, type By, type Timeline as TimelineRows, type Detail, type DetailView, type Entry, type Ref, type Row, type Section, type Step } from './detail-logic'
import { Inbox } from './inbox'
import { DecidePage } from './Decide'
import { badge, button, card, cardList, cardTitle, chip, cn, empty, Icon, selectTrigger, sectionHead } from './ui'
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
const TASK_VIEW_KEY = 'nawaban-web-task-view'
const RECONNECT_MS = 3000
const W = WINDOW_WORDS.zh
const O = OKR_WORDS.zh
const TAB_NAMES: Record<Tab, string> = { decide: W.tabs.decide, okr: W.tabs.okr, tasks: W.tabs.tasks, inbox: '收件箱' }
const TAB_ICONS: Record<Tab, IconName> = { decide: 'CircleCheck', okr: 'Target', tasks: 'ListTodo', inbox: 'Inbox' }
type TaskView = 'board' | 'list'
const TASK_VIEWS: { view: TaskView; name: string; icon: IconName }[] = [
  { view: 'board', name: '看板', icon: 'SquareKanban' },
  { view: 'list', name: '列表', icon: 'List' },
]
const STATE_ICONS: Record<Item['state'], { icon: IconName; tone: string }> = {
  todo: { icon: 'Circle', tone: 'text-status-todo' },
  working: { icon: 'CircleDashed', tone: 'text-status-progress' },
  stopped: { icon: 'CircleMinus', tone: 'text-warning' },
  done: { icon: 'CircleCheck', tone: 'text-status-done' },
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
  const [taskView, setTaskView] = createSignal<TaskView>(stored(TASK_VIEW_KEY, 'board'))
  const [doneShownAll, setDoneShownAll] = createSignal(false)

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
  const columns = createMemo(() => boardColumns(groups(), doneShownAll()))
  const onTaskList = () => route().tab === 'tasks' && !route().task
  const boardShown = () => onTaskList() && taskView() === 'board'
  const pickView = (view: TaskView) => {
    keep(TASK_VIEW_KEY, view)
    setTaskView(view)
  }
  const summary = createMemo(() => summaryOf(board(), nowInSeconds()))

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
            <Show when={route().task} fallback={TAB_NAMES[route().tab]}>
              {(key) => (
                <>
                  <a href="#tasks" class="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">{TAB_NAMES.tasks}</a>
                  <Icon name="ChevronDown" class="size-3.5 -rotate-90 text-subtle-foreground" />
                  <span class="truncate tabular-nums">{key()}</span>
                </>
              )}
            </Show>
          </h1>
          <span class="ml-auto min-w-0 truncate text-muted-foreground max-md:ml-0 max-md:basis-full max-md:whitespace-normal">{summary()}</span>
          <Show when={onTaskList()}>
            <div role="group" aria-label="任务视图" class="flex shrink-0 items-center gap-0.5">
              <For each={TASK_VIEWS}>
                {(v) => (
                  <button type="button" aria-pressed={taskView() === v.view ? 'true' : 'false'} class={viewToggle} onClick={() => pickView(v.view)}>
                    <Icon name={v.icon} class="size-3.5" />
                    {v.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </header>
        <div class={cn('min-h-0 flex-1', boardShown() ? 'flex flex-col overflow-hidden max-md:overflow-visible' : 'overflow-y-auto')}>
          <div class={cn('flex w-full flex-col gap-4', boardShown() ? 'min-h-0 flex-1' : 'p-4')}>
            <Show when={!error()} fallback={<p class={cn(card, 'px-4 text-warning')}>{error()}</p>}>
              <TabsPanel value="decide" class="outline-none"><DecidePage board={board()} project={picked()} headers={headers} /></TabsPanel>
              <TabsPanel value="okr" class="outline-none"><OkrPage okr={okr()?.of === picked() ? okr()!.reading : null} error={okr()?.of === picked() ? okr()!.error : ''} /></TabsPanel>
              <TabsPanel value="tasks" class={cn('outline-none', boardShown() && 'flex min-h-0 flex-1 flex-col')}>
                <Show when={route().task} fallback={
                  <Show when={board()} fallback={<p class={empty}>{W.loading}</p>}>
                    <Show when={sections().length} fallback={<p class={cn(empty, boardShown() && 'p-4')}>这个项目还没有任务</p>}>
                      <Show when={taskView() === 'list'} fallback={<TaskBoard columns={columns()} onMore={() => setDoneShownAll((all) => !all)} />}>
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
                  </Show>
                }>
                  {(key) => <TaskDetail key={key()} detail={detail()} task={boardTaskOf(board(), key())} error={detailError()} />}
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
        <span class={cn('min-w-0 flex-1 truncate font-medium', (quiet() || props.item.doing?.stale) && 'text-muted-foreground')}>{props.item.doing?.head ?? props.item.title}</span>
        <Show when={props.item.spec}>{(spec) => <span class={badge('secondary')}>已合 {spec().done}/{spec().total}</span>}</Show>
        <span class="shrink-0 text-xs text-subtle-foreground tabular-nums">{sinceLabel(props.item, nowInSeconds(), 'zh')}</span>
      </span>
      <span class="flex min-w-0 items-center gap-2 pl-6 text-xs text-muted-foreground">
        <span class="shrink-0 text-subtle-foreground tabular-nums">{props.item.id}</span>
        <Show when={props.item.doing?.chain ?? props.item.note}>{(line) => <span class="min-w-0 truncate">{line()}</span>}</Show>
      </span>
    </a>
  )
}

const viewToggle =
  'inline-flex h-7 items-center justify-center gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] font-medium whitespace-nowrap text-muted-foreground transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:bg-muted aria-pressed:text-foreground'

type Column = ReturnType<typeof boardColumns>[number]

function TaskBoard(props: { columns: Column[]; onMore: () => void }) {
  return (
    <div class="flex min-h-0 flex-1 overflow-x-auto">
      <div class="flex min-w-272 flex-1">
        <For each={props.columns}>
          {(c) => (
            <section aria-label={`${W.groups[c.group]} ${c.count} 条`} class="flex min-w-0 flex-1 flex-col overflow-y-auto border-r border-border last:border-r-0 max-md:overflow-visible">
              <header class="sticky top-0 z-10 flex min-h-15 shrink-0 items-center gap-2 bg-background px-4 pt-4 pb-5 text-sm font-medium">
                <Icon name={STATE_ICONS[c.group].icon} class={STATE_ICONS[c.group].tone} />
                <span>{W.groups[c.group]}</span>
                <span class="font-normal text-subtle-foreground tabular-nums">{c.count}</span>
              </header>
              <div class="flex flex-col gap-3 px-2 pb-4">
                <For each={c.items}>{(x) => <TaskCard item={x} />}</For>
                <Show when={c.more}>
                  {(more) => (
                    <button type="button" class={cn(button('ghost'), 'w-full text-muted-foreground')} onClick={() => props.onMore()}>
                      {more().hidden ? W.more(more().hidden) : W.less}
                    </button>
                  )}
                </Show>
              </div>
            </section>
          )}
        </For>
      </div>
    </div>
  )
}

function TaskCard(props: { item: Item }) {
  const look = () => STATE_ICONS[props.item.state]
  return (
    <a
      href={taskHref(props.item.id)}
      class="flex shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-card text-sm text-card-foreground shadow-card outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <span class="flex flex-col gap-1.5 p-4">
        <span class="flex items-start gap-2">
          <Icon name={look().icon} class={cn('mt-0.5', look().tone)} />
          <span class={cn('min-w-0 font-medium [overflow-wrap:anywhere]', props.item.doing?.stale && 'text-muted-foreground')}>{props.item.doing?.head ?? props.item.title}</span>
        </span>
        <span class="flex min-w-0 text-subtle-foreground tabular-nums">
          <span class="min-w-0 truncate">{props.item.id}</span>
          <Show when={sinceLabel(props.item, nowInSeconds(), 'zh')}>{(since) => <span class="shrink-0 whitespace-pre"> · {since()}</span>}</Show>
        </span>
        <Show when={props.item.doing?.chain ?? props.item.note}>{(line) => <span class="line-clamp-2 text-muted-foreground [overflow-wrap:anywhere]">{line()}</span>}</Show>
      </span>
      <Show when={props.item.spec}>
        {(spec) => (
          <span class="flex gap-1 border-t border-border px-4 py-3">
            <span class={chip}>已合 {spec().done}/{spec().total}</span>
          </span>
        )}
      </Show>
    </a>
  )
}

type Folds = { isOpen: (key: string) => boolean; setOpen: (key: string, open: boolean) => void }
type RowContext = { waiting: string | null; folds: Folds }

const BODY_FOLD = 'body'
const ALL_ROWS_FOLD = 'all-rows'
const CLOSED_STATUSES = new Set(['done', 'cancelled'])
const ROLE_WORDS: Record<By, { ruling: string; row: string; tone: string }> = {
  owner: { ruling: '决策者', row: '决策者', tone: 'text-foreground' },
  agent: { ruling: '编排者代定', row: '代定', tone: 'text-subtle-foreground' },
}
const STEP_LOOKS: Record<Step['status'], { bar: string; word: string }> = {
  completed: { bar: 'bg-muted-foreground', word: 'text-subtle-foreground max-md:hidden' },
  in_progress: { bar: 'bg-foreground', word: 'text-foreground' },
  pending: { bar: 'bg-border', word: 'text-subtle-foreground max-md:hidden' },
}
const fieldLabel = 'text-xs text-muted-foreground'
const metaText = 'text-xs text-subtle-foreground tabular-nums'
const STEPS_HUGGING_THE_RIGHT_EDGE_FROM = 3
const quietLink = 'underline decoration-subtle-foreground underline-offset-4 outline-none hover:decoration-foreground focus-visible:decoration-foreground'
const prose = 'space-y-3 text-sm leading-6 text-foreground [overflow-wrap:anywhere] [&_a]:text-foreground [&_a]:underline [&_h3]:text-sm [&_ol]:block [&_ul]:block'
const rowLine = 'flex w-full min-w-0 items-start gap-2 px-2 py-1.5 text-left text-sm leading-5 max-md:py-3'
const foldRow = cn(rowLine, 'rounded-lg outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50')
const markCell = 'flex h-5 w-4 shrink-0 items-center justify-center'
const oneLine = 'md:truncate max-md:line-clamp-2'
const wholeText = 'whitespace-pre-wrap [overflow-wrap:anywhere]'

function TaskDetail(props: { key: string; detail: Detail | null; task: BoardTask | null; error: string }) {
  const [opened, setOpened] = createSignal<Record<string, boolean>>({})
  const folds: Folds = {
    isOpen: (key) => !!opened()[props.key + '|' + key],
    setOpen: (key, open) => setOpened((all) => ({ ...all, [props.key + '|' + key]: open })),
  }
  const shown = createMemo(() => (props.detail?.id === props.key ? { detail: props.detail, view: detailView(props.detail, props.task, nowInSeconds()) } : null))
  return (
    <Show when={shown()} fallback={<p class={empty}>{props.error || W.loading}</p>}>
      {(s) => <DetailCard detail={s().detail} view={s().view} task={props.task} folds={folds} />}
    </Show>
  )
}

function DetailCard(props: { detail: Detail; view: DetailView; task: BoardTask | null; folds: Folds }) {
  const look = () => STATE_ICONS[props.view.state]
  const saysSomethingNow = () => props.view.headline.length || props.view.steps || props.view.ruling || props.view.sections.length
  return (
    <article class="mx-auto flex w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-card">
      <header class="flex flex-col gap-2 border-b border-border px-6 py-5 max-md:px-4">
        <div class="flex items-start gap-3">
          <Icon name={look().icon} class={cn('mt-1 size-5', look().tone)} />
          <h2 class="min-w-0 text-2xl leading-tight font-semibold text-foreground [overflow-wrap:anywhere]">{props.detail.title}</h2>
        </div>
        <p class={cn(metaText, 'pl-8')}>建于 {stampOf(props.detail.created_at)}</p>
      </header>
      <div class="flex max-md:flex-col">
        <div class="flex min-w-0 flex-1 flex-col max-md:contents">
          <Show when={saysSomethingNow()}>
            <div class="flex flex-col divide-y divide-border max-md:order-1">
              <NowPart view={props.view} />
              <BodyPart sections={props.view.sections} folds={props.folds} />
            </div>
          </Show>
          <Timeline timeline={props.view.timeline} waiting={props.view.waiting} folds={props.folds} />
        </div>
        <aside class="flex w-72 shrink-0 flex-col gap-4 border-l border-border p-6 max-md:order-2 max-md:w-full max-md:border-t max-md:border-l-0 max-md:p-4">
          <SideFields detail={props.detail} view={props.view} task={props.task} />
        </aside>
      </div>
    </article>
  )
}

function NowPart(props: { view: DetailView }) {
  return (
    <Show when={props.view.headline.length || props.view.steps || props.view.ruling}>
      <section aria-label="现在" class="flex flex-col gap-4 p-6 max-md:p-4">
        <Show when={props.view.headline.length}>
          <p class={cn(cardTitle, 'text-foreground [overflow-wrap:anywhere]')}>
            <Show when={props.view.waiting}><span class="text-warning">{W.waiting}　</span></Show>
            <For each={props.view.headline}>
              {(part) => (typeof part === 'string' ? part : <a class={quietLink} href={part.href} target="_blank" rel="noreferrer">{part.label}</a>)}
            </For>
          </p>
        </Show>
        <Show when={props.view.steps}>{(steps) => <Milestones steps={steps()} />}</Show>
        <Show when={props.view.ruling}>
          {(ruling) => (
            <div class="flex flex-col gap-1">
              <p class="truncate text-sm leading-6 text-muted-foreground">{ruling().line}</p>
              <p class="text-xs text-subtle-foreground [overflow-wrap:anywhere]">
                <span class={ROLE_WORDS[ruling().by].tone}>{ROLE_WORDS[ruling().by].ruling}</span>
                <span class="tabular-nums"> · {stampOf(ruling().at)}</span>
                <Show when={ruling().question}>{(question) => <span> · 问：{question()}</span>}</Show>
              </p>
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}

function Milestones(props: { steps: Step[] }) {
  return (
    <ol class="grid grid-cols-6 gap-2">
      <For each={props.steps}>
        {(step, i) => (
          <li aria-current={step.status === 'in_progress' ? 'step' : undefined} class={cn('flex min-w-0 flex-col gap-1.5', i() >= STEPS_HUGGING_THE_RIGHT_EDGE_FROM && 'max-md:items-end')}>
            <span aria-hidden="true" class={cn('h-1 w-full rounded-full', STEP_LOOKS[step.status].bar)} />
            <span class={cn('text-xs whitespace-nowrap', STEP_LOOKS[step.status].word)}>{step.word}</span>
          </li>
        )}
      </For>
    </ol>
  )
}

function BodyPart(props: { sections: Section[]; folds: Folds }) {
  const [clipped, setClipped] = createSignal(false)
  const open = () => props.folds.isOpen(BODY_FOLD)
  const clipping = new ResizeObserver(([seen]) => !open() && seen && setClipped(seen.target.scrollHeight > seen.target.clientHeight))
  onCleanup(() => clipping.disconnect())
  const watchClipping = (el: HTMLDivElement) => {
    clipping.disconnect()
    clipping.observe(el)
  }
  return (
    <Show when={props.sections.length}>
      <section aria-label="正文" class="flex flex-col gap-5 p-6 max-md:p-4">
        <For each={props.sections}>
          {(section, i) => (
            <div class="flex flex-col gap-1.5">
              <Show when={section.label}>{(label) => <h3 class={fieldLabel}>{label()}</h3>}</Show>
              <Show when={i() === 0} fallback={<div class={prose} innerHTML={section.html} />}>
                <div ref={watchClipping} class={cn(prose, !open() && 'line-clamp-3')} innerHTML={section.html} />
                <Show when={open() || clipped()}>
                  <button type="button" aria-expanded={open() ? 'true' : 'false'} class={cn(button('ghost', 'sm'), '-ml-2.5 self-start text-muted-foreground')} onClick={() => props.folds.setOpen(BODY_FOLD, !open())}>
                    {open() ? '收起' : '展开'}
                  </button>
                </Show>
              </Show>
            </div>
          )}
        </For>
      </section>
    </Show>
  )
}

function Timeline(props: { timeline: TimelineRows; waiting: string | null; folds: Folds }) {
  const everything = () => props.folds.isOpen(ALL_ROWS_FOLD)
  const shownForTheOwner = () => props.timeline.forTheOwner.reduce((n, day) => n + day.rows.length, 0)
  const ctx: RowContext = { get waiting() { return props.waiting }, folds: props.folds }
  return (
    <Show when={props.timeline.total}>
      <section aria-label="时间线" class="flex flex-col gap-6 border-t border-border p-6 max-md:order-3 max-md:p-4">
        <For each={everything() ? props.timeline.everything : props.timeline.forTheOwner}>
          {(day) => (
            <div class="-mx-2 flex flex-col gap-1">
              <h3 class="px-2 text-sm font-medium text-foreground">{day.label}</h3>
              <ol class="flex flex-col">
                <For each={day.rows}>{(row) => <li>{rowView(row, ctx)}</li>}</For>
              </ol>
            </div>
          )}
        </For>
        <Show when={props.timeline.total > shownForTheOwner()}>
          <button type="button" aria-expanded={everything() ? 'true' : 'false'} class={cn(button('ghost'), 'w-full text-muted-foreground')} onClick={() => props.folds.setOpen(ALL_ROWS_FOLD, !everything())}>
            {everything() ? W.less : '显示全部 ' + props.timeline.total + ' 条'}
          </button>
        </Show>
      </section>
    </Show>
  )
}

const Clock = (props: { at: number }) => <span class="w-10 shrink-0 text-right text-xs leading-5 text-subtle-foreground tabular-nums">{clockOf(props.at)}</span>
const Dot = (props: { class: string }) => <span aria-hidden="true" class={cn('rounded-full', props.class)} />
const foldOf = (kind: Row['kind'], row: { at: number; line: string }) => kind + ':' + row.at + ':' + row.line

function SayingRow(props: { fold: string; said: Entry; folds: Folds; tone: string; closedTone?: string; mark?: JSX.Element; lead?: string; children?: JSX.Element }) {
  const open = () => props.folds.isOpen(props.fold)
  return (
    <button type="button" aria-expanded={open() ? 'true' : 'false'} class={foldRow} onClick={() => props.folds.setOpen(props.fold, !open())}>
      <Clock at={props.said.at} />
      <span class={markCell}>{props.mark}</span>
      <span class={cn('min-w-0 flex-1', open() ? wholeText : cn(oneLine, props.closedTone), props.tone)}>
        {props.lead}
        {open() ? props.said.full : props.said.line}
      </span>
      {props.children}
    </button>
  )
}

type RowViews = { [K in Row['kind']]: (row: Extract<Row, { kind: K }>, ctx: RowContext) => JSX.Element }
const ROW_VIEWS: RowViews = {
  decision: (row, ctx) => (
    <SayingRow fold={foldOf(row.kind, row)} said={row} folds={ctx.folds} mark={<Dot class="size-1.5 bg-foreground" />} tone="text-foreground" closedTone={row.by === 'owner' ? 'font-medium' : undefined}>
      <span class={cn('shrink-0 text-xs leading-5 max-md:hidden', ROLE_WORDS[row.by].tone)}>{ROLE_WORDS[row.by].row}</span>
    </SayingRow>
  ),
  ask: (row, ctx) => (
    <SayingRow
      fold={foldOf(row.kind, row)}
      said={row}
      folds={ctx.folds}
      lead={(row.line === ctx.waiting ? W.waiting : '问') + '：'}
      mark={<Dot class={cn('size-1.5', row.line === ctx.waiting ? 'bg-warning' : 'bg-subtle-foreground')} />}
      tone={row.line === ctx.waiting ? 'text-foreground' : 'text-muted-foreground'}
    />
  ),
  note: (row, ctx) => <SayingRow fold={foldOf(row.kind, row)} said={row} folds={ctx.folds} tone="text-muted-foreground" />,
  dispatch: (row) => (
    <div class={rowLine}>
      <Clock at={row.at} />
      <span class={markCell}><Dot class="size-2 border border-muted-foreground" /></span>
      <span class="min-w-0 truncate text-muted-foreground">{row.line}</span>
    </div>
  ),
}
const rowView = (row: Row, ctx: RowContext) => (ROW_VIEWS[row.kind] as (row: Row, ctx: RowContext) => JSX.Element)(row, ctx)

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex min-w-0 flex-col gap-1.5">
      <span class={fieldLabel}>{props.label}</span>
      {props.children}
    </div>
  )
}

function RefField(props: { label: string; refs: Ref[] }) {
  return (
    <Show when={props.refs.length}>
      <Field label={props.label}>
        <ul class="flex flex-col gap-2">
          <For each={props.refs}>
            {(ref) => (
              <li>
                <a href={taskHref(ref.id)} class="group flex min-w-0 flex-col outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <span class={cn('truncate text-sm group-hover:underline', CLOSED_STATUSES.has(ref.status) ? 'text-muted-foreground' : 'text-foreground')}>{ref.title}</span>
                  <span class={metaText}>{ref.id}</span>
                </a>
              </li>
            )}
          </For>
        </ul>
      </Field>
    </Show>
  )
}

function SideFields(props: { detail: Detail; view: DetailView; task: BoardTask | null }) {
  const look = () => STATE_ICONS[props.view.state]
  const stateWord = () => (props.view.state === 'stopped' && props.view.waiting ? W.waiting : W.groups[props.view.state])
  return (
    <>
      <Field label="状态">
        <span class="flex items-center gap-2 text-sm text-foreground">
          <Icon name={look().icon} class={look().tone} />
          {stateWord()}
        </span>
      </Field>
      <Show when={props.view.holder}>
        {(holder) => (
          <Field label="负责">
            <span class="flex min-w-0 items-baseline gap-2 text-sm text-foreground">
              <span class="truncate">{holder().name}</span>
              <Show when={holder().terminal}>{(terminal) => <span class={metaText}>{terminal()}</span>}</Show>
            </span>
          </Field>
        )}
      </Show>
      <RefField label="上级" refs={props.detail.parent ? [props.detail.parent] : []} />
      <RefField label="子票" refs={props.detail.children} />
      <RefField label="被挡" refs={props.detail.blocked_by} />
      <RefField label="挡着" refs={props.detail.dependents} />
      <Show when={props.view.links.length}>
        <Field label="链接">
          <ul class="flex flex-col gap-1.5">
            <For each={props.view.links}>
              {(link) => (
                <li class="flex min-w-0 text-sm text-foreground">
                  <Show when={link.href} fallback={<span class="truncate">{link.label}</span>}>
                    {(href) => <a class={cn('truncate', quietLink)} href={href()} target="_blank" rel="noreferrer">{link.label}</a>}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Field>
      </Show>
    </>
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
