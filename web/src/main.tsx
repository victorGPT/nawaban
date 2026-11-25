import { createEffect, createSignal, Match, Switch } from 'solid-js'
import { render } from '@solidjs/web'
import { onEachChange, read, routeTakingTheTokenIntoThisTab } from './api'
import { projectShown, routeOf, TABS, type Project, type Route, type Tab } from './logic'
import { Hardware } from './components/Hardware'
import { Navbar } from './components/Navbar'
import { DecidePage } from './pages/DecidePage'
import { EmptyLine } from './components/EmptyLine'
import { NotesPage } from './pages/NotesPage'
import { OkrPage } from './pages/OkrPage'
import { TaskPage } from './pages/TaskPage'
import { TasksPage } from './pages/TasksPage'

const PROJECT_KEY = 'nawaban-web-project'
const TAB_NAMES: Record<Tab, string> = { decide: '待决', tasks: '任务', okr: 'OKR', notes: '随手记' }

const stored = (key: string): string | null => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}
const keep = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

const firstRoute = routeTakingTheTokenIntoThisTab()

function App() {
  const [route, setRoute] = createSignal<Route>(firstRoute)
  const [picked, setPicked] = createSignal<string | null>(stored(PROJECT_KEY))
  const [projects, setProjects] = createSignal<Project[]>([])
  const [failure, setFailure] = createSignal('')
  const [changes, setChanges] = createSignal(0)

  window.addEventListener('hashchange', () => setRoute(routeOf(location.hash).route))
  void onEachChange(() => setChanges((n) => n + 1))
  createEffect(
    () => changes(),
    () =>
      void read<{ projects: Project[] }>('projects').then(
        (b) => (setProjects(b.projects), setFailure('')),
        (e: Error) => setFailure(e.message),
      ),
  )

  const names = () => projects().map((p) => p.name)
  const project = () => projectShown(projects(), picked())
  const pick = (name: string) => {
    keep(PROJECT_KEY, name)
    setPicked(name)
  }

  return (
    <Hardware>
      <Navbar label="页面" items={TABS.map((t) => ({ label: TAB_NAMES[t], href: '#' + t, current: route().tab === t }))} />
      <Switch fallback={<EmptyLine error={!!failure()}>{failure() || '读取中…'}</EmptyLine>}>
        <Match when={route().tab === 'decide' && names().length}>
          <DecidePage projects={names()} changes={changes()} />
        </Match>
        <Match when={route().task && project()}>
          <TaskPage id={route().task!} project={project()!} changes={changes()} />
        </Match>
        <Match when={route().tab === 'tasks' && project()}>
          <TasksPage project={project()!} projects={names()} onPick={pick} changes={changes()} />
        </Match>
        <Match when={route().tab === 'okr' && project()}>
          <OkrPage project={project()!} projects={names()} onPick={pick} changes={changes()} />
        </Match>
        <Match when={route().tab === 'notes' && project()}>
          <NotesPage project={project()!} projects={names()} onPick={pick} changes={changes()} />
        </Match>
      </Switch>
    </Hardware>
  )
}

render(() => <App />, document.getElementById('root')!)
