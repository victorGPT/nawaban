import { cn } from 'cn'
import { ICONS, type IconName } from './icons'

export { cn }

export function Icon(props: { name: IconName; class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class={cn('size-4 shrink-0', props.class)}
      innerHTML={ICONS[props.name]}
    />
  )
}

export const card = 'flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card py-4 text-sm text-card-foreground shadow-card'
export const cardList = 'flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card text-sm text-card-foreground shadow-card'
export const cardTitle = 'font-heading text-base leading-snug font-medium'

const BADGE = {
  secondary: 'bg-secondary text-secondary-foreground',
  outline: 'border-border text-foreground',
  success: 'border-status-done/30 text-status-done',
  progress: 'border-status-progress/30 text-status-progress',
  warning: 'border-warning/30 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  muted: 'border-border text-subtle-foreground',
} as const
export type BadgeVariant = keyof typeof BADGE

export const badge = (variant: BadgeVariant = 'secondary') =>
  cn('inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums', BADGE[variant])

const BUTTON = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/80',
  outline: 'border-border bg-background hover:bg-muted hover:text-foreground',
  ghost: 'hover:bg-muted hover:text-foreground',
  dismiss: 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
} as const
const BUTTON_SIZE = {
  default: 'h-8 gap-1.5 px-2.5',
  sm: 'h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem]',
  xs: 'h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs',
} as const

export const button = (variant: keyof typeof BUTTON = 'default', size: keyof typeof BUTTON_SIZE = 'default') =>
  cn(
    'inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50',
    BUTTON[variant],
    BUTTON_SIZE[size],
  )

export const input =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm'

export const selectTrigger =
  'flex h-8 w-full appearance-none items-center rounded-lg border border-input bg-transparent py-0 pr-8 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50'

export const sectionHead = 'flex h-8 items-center gap-2 px-4 text-sm'

export const empty = 'px-4 py-2 text-sm text-muted-foreground'
