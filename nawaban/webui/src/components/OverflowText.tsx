import { useEffect, useRef, useState } from "react";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";

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
    <TooltipTrigger isOpen={open} onOpenChange={setOpen}>
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
      <Tooltip triggerRef={ref} size="md" placement="top" className="nawaban-text-tooltip">
        {text}
      </Tooltip>
    </TooltipTrigger>
  );
}
