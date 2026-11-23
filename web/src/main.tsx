import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { render } from '@solidjs/web'
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/solid/tabs'
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/solid/collapsible'
import { Progress, ProgressIndicator, ProgressTrack } from '@ui-sdk/solid/progress'
import {
  foldKey, krFill, linkOf, OKR_WORDS, okrReadingOfFailure, okrView, type KrRow, type ObjectiveRow, localMonthDayTime, pendingCount, projectShown, routeOf, sinceLabel, summaryOf, taskGroups, taskHref, taskSections,
  WINDOW_WORDS, type Board, type Item, type Project, type Route, type Tab,
} from './logic'
import './style.css'

const TOKEN_KEY = 'nawaban-web-token'
const PROJECT_KEY = 'nawaban-web-project'
const FOLDS_KEY = 'nawaban-web-folds'
const SHOWN_ALL_KEY = 'nawaban-web-shown-all'
const RECONNECT_MS = 3000
const W = WINDOW_WORDS.zh
const O = OKR_WORDS.zh
const TAB_NAMES: Record<Tab, string> = { decide: W.tabs.decide, okr: W.tabs.okr, tasks: W.tabs.tasks, inbox: '收件箱' }
const STATUS_NAMES: Record<string, string> = { open: '待办', in_progress: '进行中', done: '已完成', cancelled: '已取消' }

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
    <main>
      <header class="top">
        <select class="project" aria-label="项目" value={picked() ?? ''} onChange={(e) => pick(e.currentTarget.value)}>
          <For each={projects()}>{(p) => <option value={p.name}>{p.name}</option>}</For>
        </select>
        <p class="summary">{summary()}</p>
      </header>
      <Show when={!error()} fallback={<p class="notice">{error()}</p>}>
        <Tabs value={route().tab} onValueChange={(v) => (location.hash = '#' + v)}>
          <TabsList aria-label="视图" class="segments">
            <For each={Object.keys(TAB_NAMES) as Tab[]}>{(t) => <TabsTab value={t} class="segment">{TAB_NAMES[t]}</TabsTab>}</For>
          </TabsList>
          <TabsPanel value="decide" class="panel"><p class="quiet">待决下一版接上，现在请在 Herdr 面板或终端里答。</p></TabsPanel>
          <TabsPanel value="okr" class="panel"><OkrPage okr={okr()?.of === picked() ? okr()!.reading : null} error={okr()?.of === picked() ? okr()!.error : ''} /></TabsPanel>
          <TabsPanel value="tasks" class="panel">
            <Show when={route().task} fallback={
              <Show when={board()} fallback={<p class="quiet">{W.loading}</p>}>
                <Show when={sections().length} fallback={<p class="quiet">这个项目还没有任务</p>}>
                  <For each={sections()}>
                    {(s) => (
                      <Collapsible class="group" open={s.open} onOpenChange={(open) => toggle(setFolds, foldKey(picked(), s.group), FOLDS_KEY, open)}>
                        <CollapsibleTrigger class="group-head">
                          <span>{W.groups[s.group as keyof typeof W.groups]}</span>
                          <span class="tag count">{s.count}</span>
                          <span class="chevron" aria-hidden="true" />
                        </CollapsibleTrigger>
                        <CollapsiblePanel class="rows">
                          <For each={s.items as Item[]}>{(x) => <TaskRow item={x} />}</For>
                          <Show when={s.more}>
                            {(more) => (
                              <button type="button" class="more" onClick={() => toggle(setShownAll, foldKey(picked(), s.group), SHOWN_ALL_KEY, !!more().hidden)}>
                                {more().hidden ? W.more(more().hidden) : W.less}
                              </button>
                            )}
                          </Show>
                        </CollapsiblePanel>
                      </Collapsible>
                    )}
                  </For>
                </Show>
              </Show>
            }>
              {(key) => <TaskDetail key={key()} detail={detail()} error={detailError()} />}
            </Show>
          </TabsPanel>
          <TabsPanel value="inbox" class="panel"><p class="quiet">收件箱下一版接上。</p></TabsPanel>
        </Tabs>
      </Show>
    </main>
  )
}

function TaskRow(props: { item: Item }) {
  return (
    <a class="card row" data-state={props.item.state} href={taskHref(props.item.id)}>
      <span class="line">
        <span class="title">{props.item.title}</span>
        <Show when={props.item.spec}>{(spec) => <span class="tag">{spec().done}/{spec().total}</span>}</Show>
        <span class="since">{sinceLabel(props.item, nowInSeconds(), 'zh')}</span>
      </span>
      <span class="line meta">
        <span class="id">{props.item.id}</span>
        <Show when={props.item.note}>{(note) => <span class="note">{note()}</span>}</Show>
      </span>
    </a>
  )
}

function RefList(props: { label: string; refs: Ref[] }) {
  return (
    <Show when={props.refs.length}>
      <div class="fact">
        <span class="label">{props.label}</span>
        <span class="refs">
          <For each={props.refs}>
            {(r) => (
              <a href={taskHref(r.id)} class="ref" data-status={r.status}>
                {r.id} {r.title}
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
    <article class="detail">
      <a href="#tasks" class="back">← {W.tabs.tasks}</a>
      <Show when={d()} fallback={<p class="quiet">{props.error || W.loading}</p>}>
        {(t) => (
          <>
            <section class="card">
              <div class="line meta">
                <span class="id">{t().id}</span>
                <span class="tag" data-status={t().status}>{STATUS_NAMES[t().status] ?? t().status}</span>
                <Show when={t().session}>{(s) => <span>{s()}</span>}</Show>
                <span class="since">{when(t().created_at)}</span>
              </div>
              <h1>{t().title}</h1>
              <Show when={t().body} fallback={<p class="quiet">没有正文</p>}>
                <div class="body">{t().body}</div>
              </Show>
              <RefList label="上级" refs={t().parent ? [t().parent!] : []} />
              <RefList label="子票" refs={t().children} />
              <RefList label="被挡" refs={t().blocked_by} />
              <RefList label="挡着" refs={t().dependents} />
            </section>
            <Part title={W.facts.note} empty="还没有进展" items={t().latest_note ? [t().latest_note!] : []} />
            <Part title="决策记录" empty="没有决策记录" items={t().decisions} />
            <section class="part">
              <h2>链接</h2>
              <Show when={t().links.length} fallback={<p class="quiet">没有链接</p>}>
                <div class="card list">
                  <For each={t().links}>
                    {(e) => {
                      const link = linkOf(e.body)
                      return (
                        <div class="entry">
                          <span class="tag" data-kind="link">{link.kind || '链接'}</span>
                          <Show when={link.href} fallback={<span class="text">{link.ref}</span>}>
                            {(href) => <a class="text" href={href()} target="_blank" rel="noreferrer">{link.ref}</a>}
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

function Part(props: { title: string; empty: string; items: Event[]; tagged?: boolean }) {
  return (
    <section class="part">
      <h2>{props.title}</h2>
      <Show when={props.items.length} fallback={<p class="quiet">{props.empty}</p>}>
        <div class="card list">
          <For each={props.items}>
            {(e) => (
              <div class="entry">
                <div class="line meta">
                  <Show when={props.tagged}>
                    <span class="tag" data-kind={e.kind}>{KIND_NAMES[e.kind] ?? e.kind}</span>
                  </Show>
                  <span>{e.author}</span>
                  <span class="since">{when(e.at)}</span>
                </div>
                <div class="text">{e.body}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

render(() => <App />, document.getElementById('root')!)

function OkrPage(props: { okr: unknown; error: string }) {
  const view = createMemo(() => okrView(props.okr))
  return (
    <Show when={!props.error} fallback={<p class="notice">{props.error}</p>}>
      <Show when={props.okr} fallback={<p class="quiet">{W.loading}</p>}>
        <Show when={view()} fallback={<p class="quiet">{O.noObjective}</p>}>
          {(v) => (
            <>
              <p class="quiet tally">{O.tally(v().met, v().total, v().measured)}</p>
              <For each={v().objectives}>{(o) => <ObjectiveCard o={o} />}</For>
            </>
          )}
        </Show>
      </Show>
    </Show>
  )
}

function ObjectiveCard(props: { o: ObjectiveRow }) {
  const o = () => props.o
  return (
    <section class="card objective">
      <Show
        when={o().standing !== 'met'}
        fallback={
          <Collapsible>
            <CollapsibleTrigger class="o-head fold-head">
              <span class="o-name quiet-name">{o().name}</span>
              <span class="o-tally" data-standing="met">{O.allMet} {o().met}/{o().total}</span>
            </CollapsibleTrigger>
            <CollapsiblePanel class="krs"><For each={o().metKrs}>{(k) => <KrLine k={k} quiet />}</For></CollapsiblePanel>
          </Collapsible>
        }
      >
        <header class="o-head">
          <h2 class="o-name">{o().name}</h2>
          <span class="o-tally" data-standing={o().standing}>{o().met}/{o().total}</span>
        </header>
        <div class="krs"><For each={o().krs}>{(k) => <KrLine k={k} />}</For></div>
        <Fold label={O.untestedFolded(o().untestedKrs.length)} krs={o().untestedKrs} />
        <Fold label={O.metFolded(o().metKrs.length)} krs={o().metKrs} />
      </Show>
    </section>
  )
}

function Fold(props: { label: string; krs: KrRow[] }) {
  return (
    <Show when={props.krs.length}>
      <Collapsible>
        <CollapsibleTrigger class="fold-head">
          <span class="chevron" aria-hidden="true" />
          {props.label}
        </CollapsibleTrigger>
        <CollapsiblePanel class="krs"><For each={props.krs}>{(k) => <KrLine k={k} quiet />}</For></CollapsiblePanel>
      </Collapsible>
    </Show>
  )
}

function KrLine(props: { k: KrRow; quiet?: boolean }) {
  const k = () => props.k
  const fill = () => krFill(k())
  return (
    <div class="kr" data-status={k().status} data-quiet={props.quiet ? '' : undefined}>
      <div class="kr-name">{k().name}</div>
      <Show when={fill() != null}>
        <Progress value={Math.round(fill()! * 100)} aria-label={k().name} class="kr-bar">
          <ProgressTrack class="track"><ProgressIndicator class="fill" /></ProgressTrack>
        </Progress>
      </Show>
      <div class="reading">
        <Show when={k().measured} fallback={<span class="dim">{O.status.untested} / {O.target} {k().target}</span>}>
          <span class="value">{k().value}</span>
          <span class="dim">/ {O.target} {k().target}</span>
          <Show when={k().gap}>
            <span class="dim">· {O.variance}</span>
            <span class="light">{k().gap}</span>
          </Show>
          <span class="dim">·</span>
          <span class="light">{O.status[k().status]}</span>
          <Show when={k().day}><span class="dim">· {O.asOfShort} {k().day}</span></Show>
        </Show>
      </div>
    </div>
  )
}
