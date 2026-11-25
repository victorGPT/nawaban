import type { JSX } from '@solidjs/web'

export type DeviceLayout = 'split' | 'wide' | 'narrow'

export function Device(props: { label: string; layout: DeviceLayout; detail?: boolean; children: JSX.Element }) {
  return (
    <main data-page>
      <section data-device aria-label={props.label} data-layout={props.layout} data-detail={props.detail || undefined}>
        {props.children}
      </section>
    </main>
  )
}
