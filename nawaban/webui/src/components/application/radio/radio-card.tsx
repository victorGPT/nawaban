import type { ReactNode } from "react";
import { RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

/**
 * App composition: the selectable decision card — title + optional
 * description on the left, the radio dot on the right, the whole card
 * clickable. shadcn's radio-group ships the control only.
 */
export function RadioCard({
  value,
  title,
  description,
  className,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "group/field-label flex w-full cursor-pointer items-center justify-between gap-3 rounded-2lg border border-border-button-default bg-background-primary-default py-3 pr-5 pl-4 transition-colors duration-150 select-none hover:bg-background-primary-hover",
        className,
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-body-medium text-text-primary">{title}</span>
        {description !== undefined && description !== null && (
          <span className="truncate text-body-regular text-text-secondary">{description}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center py-1">
        <RadioGroupItem value={value} />
      </span>
    </label>
  );
}
