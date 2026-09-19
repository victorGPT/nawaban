import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// BoardUI deltas to the generated base-nova badge (version B): this one badge
// covers both Figma components the hand-built kit had — the numeric counter
// (`size="count"`) and the status chip (`size="bold" | "subtle" | "caption"`
// with the lime/rose/yellow/cyan/blue/purple/neutral/gray/soft colours).
// Shape and type moved out of the cva base into a `size` axis so those two
// shapes can coexist with nova's default pill. The BoardUI sizes also drop
// the 1px transparent border nova's base adds, which grew every pill by 2px.
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden border border-transparent whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
        count: "bg-badge-neutral-background text-text-secondary",
        "count-primary": "bg-accent-400 text-white",
        lime: "bg-status-lime-background text-status-lime-text",
        rose: "bg-status-rose-background text-status-rose-text",
        yellow: "bg-status-yellow-background text-status-yellow-text",
        cyan: "bg-status-cyan-background text-status-cyan-text",
        blue: "bg-status-blue-background text-status-blue-text",
        purple: "bg-status-purple-background text-status-purple-text",
        neutral: "bg-background-tertiary-default text-text-secondary",
        gray: "bg-background-secondary-default text-text-primary",
        soft: "bg-background-secondary-default text-text-secondary",
      },
      size: {
        default: "h-5 rounded-4xl px-2 py-0.5 text-xs font-medium",
        count: "border-0 rounded-sm px-1 py-px text-caption-1-semibold tracking-normal",
        bold: "border-0 rounded-md px-1.5 py-0.5 text-body-medium",
        subtle: "border-0 rounded-md px-1.5 py-1 text-body-medium",
        caption: "border-0 rounded-md px-1.5 py-1 text-caption-1-medium",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
