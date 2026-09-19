import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Text inside a task button must not introduce another interactive element.
export function OverflowText({ text, className, as: Element = "span" }: {
  text: string;
  className?: string;
  as?: "span" | "code";
}) {
  const ref = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);
  return (
    <Tooltip
      open={open}
      disableHoverablePopup
      // This component measures clipping itself before opening, so Base UI's
      // own hover/focus opens are ignored.
      onOpenChange={(next, details) => {
        if (next && (details.reason === "trigger-hover" || details.reason === "trigger-focus")) return;
        setOpen(next);
      }}
    >
      <TooltipTrigger
        render={
          <Element
            ref={ref}
            className={className}
            onMouseEnter={(event) => {
              const el = event.currentTarget;
              setOpen(el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
            }}
            onMouseLeave={() => setOpen(false)}
            onPointerDown={() => setOpen(false)}
          >
            {text}
          </Element>
        }
      />
      <TooltipContent side="top" className="nawaban-text-tooltip">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
