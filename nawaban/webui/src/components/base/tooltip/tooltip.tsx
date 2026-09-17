"use client";

import { Children, isValidElement, useId } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { cx, sortCx } from "@/utils/cx";

export type TooltipSize = "sm" | "md";
const sizes = sortCx({ sm: "px-2.5 py-1.5 text-caption-1-medium", md: "px-3 py-2 text-body-medium rounded-2lg" });

export const TOOLTIP_CARETS = sortCx({
  top: { width: 12, height: 7, path: "M0 0 L6 6 L12 0", shadow: "0 1.5px 1px" },
  bottom: { width: 12, height: 7, path: "M0 7 L6 1 L12 7", shadow: "0 -1.5px 1px" },
  // left/right carets stick out sideways from the body; their shadow should
  // still fall *downward* (light-from-top, matching the body's shadow-dropdown)
  // rather than horizontally, which read as floating.
  left: { width: 7, height: 12, path: "M0 0 L6 6 L0 12", shadow: "0 1.5px 1px" },
  right: { width: 7, height: 12, path: "M7 0 L1 6 L7 12", shadow: "0 1.5px 1px" },
});

type Placement = "top" | "bottom" | "left" | "right" | "top start" | "top end" | "bottom start" | "bottom end";
export interface TooltipProps extends Omit<ComponentProps<typeof BaseTooltip.Popup>, "children"> {
  children?: ReactNode;
  size?: TooltipSize;
  showArrow?: boolean;
  offset?: number;
  placement?: Placement;
  triggerRef?: RefObject<HTMLElement | null>;
}

export function Tooltip({ children, className, size = "sm", showArrow = true, offset = 10, placement = "top", triggerRef, ...props }: TooltipProps) {
  const [side, edge] = placement.split(" ") as ["top" | "bottom" | "left" | "right", "start" | "end" | undefined];
  return <BaseTooltip.Portal>
    <BaseTooltip.Positioner side={side} align={edge ?? "center"} sideOffset={offset} anchor={triggerRef} className="pointer-events-none bui-tooltip-layer">
      <BaseTooltip.Popup {...props} className={(state) => cx(
        "pointer-events-none max-w-[240px] select-none rounded-lg border border-border-button-default bg-background-primary-default text-text-primary shadow-dropdown",
        sizes[size], "transition duration-200 ease-out",
        "data-[starting-style]:scale-90 data-[starting-style]:opacity-0 data-[starting-style]:blur-[4px]",
        "data-[ending-style]:scale-90 data-[ending-style]:opacity-0 data-[ending-style]:blur-[4px]",
        typeof className === "function" ? className(state) : className,
      )}>
        {showArrow && <BaseTooltip.Arrow className="data-[side=top]:-bottom-[7px] data-[side=bottom]:-top-[7px] data-[side=left]:-right-[7px] data-[side=right]:-left-[7px]" render={(arrowProps, state) => {
          const caret = TOOLTIP_CARETS[state.side === "inline-start" ? "left" : state.side === "inline-end" ? "right" : state.side];
          return <div {...arrowProps}><svg width={caret.width} height={caret.height} viewBox={`0 0 ${caret.width} ${caret.height}`} className="block overflow-visible fill-background-primary-default stroke-border-button-default"><path d={caret.path} /></svg></div>;
        }} />}
        {children}
      </BaseTooltip.Popup>
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>;
}

export interface TooltipTriggerProps {
  children: ReactNode;
  delay?: number;
  closeDelay?: number;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  isDisabled?: boolean;
}

/** Compose onto the existing element so text inside task buttons stays non-interactive. */
export function TooltipTrigger({ delay = 0, closeDelay = 0, children, isOpen, defaultOpen, onOpenChange, isDisabled }: TooltipTriggerProps) {
  const triggerId = useId();
  const [trigger, popup] = Children.toArray(children);
  const managedAnchor = isValidElement<TooltipProps>(popup) && popup.props.triggerRef !== undefined;
  return <BaseTooltip.Root open={isOpen} defaultOpen={defaultOpen} disabled={isDisabled} triggerId={triggerId} disableHoverablePopup onOpenChange={(open, details) => {
    // OverflowText measures clipping itself before opening on pointer entry.
    if (managedAnchor && open && (details.reason === "trigger-hover" || details.reason === "trigger-focus")) return;
    onOpenChange?.(open);
  }}>
    {isValidElement(trigger) && <BaseTooltip.Trigger id={triggerId} delay={delay} closeDelay={closeDelay} render={trigger} />}
    {popup}
  </BaseTooltip.Root>;
}
