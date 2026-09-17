"use client";

import { useRef, useState, type RefObject } from "react";
import { Popover } from "@base-ui/react/popover";
import type { CalendarDate } from "@internationalized/date";
import { RiCalendarLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { BoardCalendar, DateChipInput, formatTriggerDate, popoverClassName, triggerButtonClassName } from "./shared";
import { fromPickerDate, toPickerDate } from "./dates";
import { cx } from "@/utils/cx";

export interface DatePickerProps {
  value?: CalendarDate | null;
  defaultValue?: CalendarDate | null;
  onChange?: (value: CalendarDate | null) => void;
  isDisabled?: boolean;
  className?: string;
  "aria-label"?: string;
  /** External anchors retain their own trigger and open-state handling. */
  triggerRef?: RefObject<HTMLElement | null>;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
}

function DateEditor({ value, label, onApply, onCancel }: {
  value: CalendarDate | null;
  label: string;
  onApply: (value: CalendarDate | null) => void;
  onCancel: () => void;
}) {
  const [pendingValue, setPendingValue] = useState(value);
  const [month, setMonth] = useState(value ? toPickerDate(value) : new Date());
  return (
    <div className="flex flex-col gap-3 p-2 pb-3">
      <BoardCalendar
        aria-label={label}
        mode="single"
        required
        selected={pendingValue ? toPickerDate(pendingValue) : undefined}
        onSelect={(date) => setPendingValue(fromPickerDate(date))}
        month={month}
        onMonthChange={setMonth}
      />
      <div className="flex items-center justify-between gap-3 px-4">
        <div>
          {pendingValue && <DateChipInput date={pendingValue} label="Date" onCommit={(date) => {
            setPendingValue(date);
            setMonth(toPickerDate(date));
          }} />}
        </div>
        <div className="flex items-center gap-2.5">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button onClick={() => onApply(pendingValue)} disabled={!pendingValue}>Apply</Button>
        </div>
      </div>
    </div>
  );
}

export function DatePicker({ value, defaultValue = null, onChange, isDisabled, className,
  "aria-label": ariaLabel = "Date", triggerRef: externalTriggerRef,
  isOpen: controlledOpen, onOpenChange,
}: DatePickerProps) {
  const ownTriggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const triggerRef = externalTriggerRef ?? ownTriggerRef;
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const [internalValue, setInternalValue] = useState(defaultValue);
  const committedValue = value !== undefined ? value : internalValue;
  const setOpen = (open: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(open);
    onOpenChange?.(open);
  };
  return (
    <Popover.Root open={isOpen} onOpenChange={(open, details) => {
      // The existing external trigger owns its click toggle.
      if (!open && externalTriggerRef?.current?.contains(details.event.target as Node)) return;
      setOpen(open);
    }} modal={false}>
      {!externalTriggerRef && (
        <Popover.Trigger ref={ownTriggerRef} disabled={isDisabled} aria-label={ariaLabel} className={cx(triggerButtonClassName, className)}>
          <RiCalendarLine className="size-5 shrink-0 text-foreground-icon-primary" aria-hidden />
          <span className="flex items-center justify-center whitespace-nowrap px-1 text-body-medium text-text-primary">
            {committedValue ? formatTriggerDate(committedValue) : "Select date"}
          </span>
        </Popover.Trigger>
      )}
      <Popover.Portal>
        <Popover.Positioner anchor={externalTriggerRef} sideOffset={4} align="end" className="bui-popup-layer">
          <Popover.Popup ref={popupRef} initialFocus={() => popupRef.current?.querySelector<HTMLElement>('[role="grid"] button[tabindex="0"]') ?? true} aria-label={ariaLabel} finalFocus={triggerRef} className={popoverClassName}>
            <DateEditor key={String(isOpen)} value={committedValue} label={ariaLabel} onCancel={() => setOpen(false)} onApply={(next) => {
              if (value === undefined) setInternalValue(next);
              onChange?.(next);
              setOpen(false);
            }} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
