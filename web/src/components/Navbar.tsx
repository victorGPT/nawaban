import { For } from 'solid-js'

export type NavItem = { label: string; href: string; current: boolean }

export function Navbar(props: { label: string; items: NavItem[] }) {
  return (
    <header data-kit="navbar">
      <nav aria-label={props.label} data-kit="navbar-links">
        <For each={props.items}>
          {(item) => (
            <a href={item.href} data-kit="navbar-link" draggable={false} aria-current={item.current ? 'page' : undefined}>
              {item.label}
            </a>
          )}
        </For>
      </nav>
    </header>
  )
}
