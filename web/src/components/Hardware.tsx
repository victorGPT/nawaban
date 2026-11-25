import type { JSX } from '@solidjs/web'
import '@fontsource/geist/400.css'
import '@fontsource/geist/500.css'
import '@fontsource/geist/600.css'
import '../hardware/skin.css'
import './components.css'

const KEY_COLOR = { '--theme-l': '0.64', '--theme-c': '0.31', '--theme-h': '48' }
const NAVIGATION_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])

let focusRingsFollowTheKeyboard = false
function showFocusRingsOnlyForTheKeyboard() {
  if (focusRingsFollowTheKeyboard) return
  focusRingsFollowTheKeyboard = true
  const root = document.documentElement
  document.addEventListener('pointerdown', () => (root.dataset.modality = 'pointer'), true)
  document.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).matches?.('input, textarea, [contenteditable]')
    if (e.key === 'Tab' || (NAVIGATION_KEYS.has(e.key) && !typing)) root.dataset.modality = 'keyboard'
  }, true)
}

export function Hardware(props: { children: JSX.Element }) {
  showFocusRingsOnlyForTheKeyboard()
  return (
    <div data-skin="hardware" data-app lang="zh-CN" style={KEY_COLOR}>
      {props.children}
    </div>
  )
}
