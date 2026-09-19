import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// BoardUI deltas to the generated base-nova button (version B):
//  - base: `transition-all` + `active:translate-y-px` swapped for the
//    `button-press-motion` utility (theme.css) so presses keep BoardUI's scale.
//  - variants default/destructive/outline/link carry BoardUI's Figma tokens
//    (gradient fills, accent link) instead of the nova palette.
//  - `soft` is new: BoardUI's accent-tinted ghost button.
//  - `link-muted` is new: BoardUI's secondary LinkButton.
//  - sizes carry BoardUI's type ramp (text-body-medium / text-caption-1-semibold),
//    radii (2lg / lg / sm) and icon sizes (20 / 18 / 14px).
//  - `default`/`lg` carry explicit vertical padding: legacy app CSS cancels
//    the fixed height on composed buttons (.content-button), and shadcn's
//    height-only sizing would then collapse them.
//  - the base drops `text-sm font-medium`: the size variants carry BoardUI's
//    composite text-* utilities, and a bare font-medium is a different class
//    group, so it silently overrode `text-body-regular` on composed buttons.
//  - disabled buttons keep pointer events (so `title` still shows) and are
//    dimmed by the per-variant disabled tokens, not an extra opacity-50.
//  - sizes `link` and `link-xs` are new: inline text actions with no container,
//    which shadcn's `link` variant otherwise renders at button height.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding whitespace-nowrap button-press-motion outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed aria-disabled:cursor-not-allowed aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-button-primary text-text-white shadow-xs disabled:text-button-primary-disabled-foreground disabled:shadow-none aria-disabled:text-button-primary-disabled-foreground aria-disabled:shadow-none",
        outline:
          "border-input bg-background-primary-default text-text-primary shadow-xs hover:bg-background-primary-hover hover:border-border-button-hover active:bg-background-primary-active active:border-border-button-active aria-expanded:bg-background-primary-hover disabled:bg-background-primary-disabled disabled:text-text-tertiary disabled:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        soft: "bg-button-ghost-background text-button-ghost-foreground hover:bg-button-ghost-hover active:bg-button-ghost-active disabled:bg-button-ghost-disabled disabled:text-button-ghost-disabled-foreground disabled:shadow-none",
        destructive:
          "bg-button-danger text-text-white shadow-xs disabled:text-foreground-disabled-danger disabled:shadow-none aria-disabled:text-foreground-disabled-danger aria-disabled:shadow-none",
        link: "text-accent-600 underline-offset-3 hover:underline active:text-accent-800 disabled:text-text-tertiary disabled:no-underline",
        "link-muted":
          "text-text-secondary underline-offset-3 hover:underline active:text-text-primary disabled:text-text-tertiary disabled:no-underline",
      },
      size: {
        default:
          "h-8 gap-1 px-2.5 py-1.5 text-body-medium has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-[18px]",
        xs: "h-6 gap-1 rounded-sm px-2.5 text-caption-1-semibold in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1 rounded-2lg px-3 py-2 text-body-medium has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-5",
        link: "h-auto gap-1 rounded-sm p-0 text-body-medium [&_svg:not([class*='size-'])]:size-[18px]",
        "link-xs":
          "h-auto gap-1 rounded-sm p-0 text-caption-1-semibold [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-8 [&_svg:not([class*='size-'])]:size-[18px]",
        "icon-xs":
          "size-6 rounded-sm in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9 rounded-2lg [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
