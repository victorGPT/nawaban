"use client";

import { useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Button as BaseButton } from "@base-ui/react/button";
import type { DateRange } from "@daypicker/react";
import { daysInRange, fromPickerDate, toPickerDate } from "./dates";
import {
  CalendarDate,
  endOfMonth,
  endOfYear,
  getLocalTimeZone,
  isSameDay,
  startOfMonth,
  startOfYear,
  today,
} from "@internationalized/date";
import { RiCalendarLine } from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/base/buttons/button";
import {
  DateChipInput,
  BoardCalendar,
  formatTriggerDate,
  popoverClassName,
  triggerButtonClassName,
} from "@/components/base/date-picker/shared";
import { cx } from "@/utils/cx";
import { t, useLocale } from "@/i18n";

export interface DateRangeValue {
  start: CalendarDate;
  end: CalendarDate;
}

export interface DateRangePickerProps {
  value?: DateRangeValue | null;
  defaultValue?: DateRangeValue | null;
  onChange?: (value: DateRangeValue | null) => void;
  isDisabled?: boolean;
  className?: string;
  "aria-label"?: string;
  /** Trigger text shown when no range is committed yet. Default "Select date range". */
  placeholder?: string;
}

function useQuickSelectPresets() {
  useLocale();
  const now = today(getLocalTimeZone());
  const lastMonth = now.subtract({ months: 1 });
  const lastYear = now.subtract({ years: 1 });
  return [
    { id: "today", label: t("today"), range: { start: now, end: now } },
    { id: "yesterday", label: t("yesterday"), range: { start: now.subtract({ days: 1 }), end: now.subtract({ days: 1 }) } },
    { id: "lastWeek", label: t("lastWeek"), range: { start: now.subtract({ days: 7 }), end: now.subtract({ days: 1 }) } },
    { id: "thisMonth", label: t("thisMonth"), range: { start: startOfMonth(now), end: endOfMonth(now) } },
    { id: "lastMonth", label: t("lastMonth"), range: { start: startOfMonth(lastMonth), end: endOfMonth(lastMonth) } },
    { id: "thisYear", label: t("thisYear"), range: { start: startOfYear(now), end: endOfYear(now) } },
    { id: "lastYear", label: t("lastYear"), range: { start: startOfYear(lastYear), end: endOfYear(lastYear) } },
    { id: "allTime", label: t("allTime"), range: { start: now.subtract({ years: 10 }), end: now } },
  ];
}

function isPresetActive(value: DateRangeValue | null, range: DateRangeValue) {
  return !!value && isSameDay(value.start, range.start) && isSameDay(value.end, range.end);
}

function QuickSelect({
  value,
  onSelect,
}: {
  value: DateRangeValue | null;
  onSelect: (range: DateRangeValue) => void;
}) {
  const presets = useQuickSelectPresets();

  return (
    <div className="flex w-auto shrink-0 flex-wrap gap-1.5 sm:w-[118px] sm:flex-col">
      {presets.map((preset) => (
        <BaseButton
          key={preset.id}
          type="button"
          onClick={() => onSelect(preset.range)}
          className={cx(
            "cursor-pointer rounded-2lg sm:w-full px-2 py-1.5 text-left text-body-medium text-text-primary transition-colors duration-150 ease",
            isPresetActive(value, preset.range)
              ? "bg-background-tertiary-default"
              : "hover:bg-background-secondary-hover",
          )}
        >
          {preset.label}
        </BaseButton>
      ))}
    </div>
  );
}

function Footer({
  value,
  onChange,
  onCancel,
  onApply,
}: {
  value: DateRangeValue | null;
  onChange: (value: DateRangeValue) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  useLocale();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-3 pr-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <AnimatePresence>
          {value && (
            <motion.div
              key="range-summary"
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.25, ease: [0.34, 1.2, 0.64, 1] }}
              className="flex flex-wrap items-center gap-2.5"
            >
              <div className="flex items-center gap-[5px]">
                <DateChipInput
                  date={value.start}
                  label={t("startDate")}
                  onCommit={(start) =>
                    onChange({ start, end: start.compare(value.end) > 0 ? start : value.end })
                  }
                />
                <span className="text-body-medium text-text-secondary">-</span>
                <DateChipInput
                  date={value.end}
                  label={t("endDate")}
                  onCommit={(end) =>
                    onChange({ start: end.compare(value.start) < 0 ? end : value.start, end })
                  }
                />
              </div>
              <span className="rounded-xl bg-background-tertiary-default px-2 py-2 text-body-medium text-text-secondary">
                {t(daysInRange(value) === 1 ? "selectedDay" : "selectedDays", { count: daysInRange(value) })}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button onClick={onApply} disabled={!value}>
          {t("apply")}
        </Button>
      </div>
    </div>
  );
}

function RangeEditor({ value, label, onApply, onCancel }: {
  value: DateRangeValue | null;
  label: string;
  onApply: (value: DateRangeValue) => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState<DateRange | undefined>(value ? {
    from: toPickerDate(value.start), to: toPickerDate(value.end),
  } : undefined);
  const [month, setMonth] = useState(value ? toPickerDate(value.start) : new Date());
  const pendingValue = pending?.from && pending.to ? {
    start: fromPickerDate(pending.from), end: fromPickerDate(pending.to),
  } : null;
  const changeRange = (range: DateRangeValue) => {
    setPending({ from: toPickerDate(range.start), to: toPickerDate(range.end) });
    setMonth(toPickerDate(range.start));
  };
  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <div className="pt-4 pl-4"><QuickSelect value={pendingValue} onSelect={changeRange} /></div>
      <div className="flex flex-col pt-2 pr-2 pb-3">
        <BoardCalendar
          aria-label={label}
          mode="range"
          selected={pending}
          onSelect={(next, date) => {
            // A completed range starts a new two-click selection instead of
            // extending its old start when the user chooses another day.
            setPending(pending?.from && !pending.to ? next : { from: date, to: undefined });
          }}
          numberOfMonths={2}
          month={month}
          onMonthChange={setMonth}
        />
        <Footer value={pendingValue} onChange={changeRange} onCancel={onCancel}
          onApply={() => { if (pendingValue) onApply(pendingValue); }} />
      </div>
    </div>
  );
}

export function DateRangePicker({ value, defaultValue = null, onChange, isDisabled, className,
  "aria-label": ariaLabel, placeholder,
}: DateRangePickerProps) {
  useLocale();
  const label = ariaLabel ?? t("dateRange");
  const displayPlaceholder = placeholder ?? t("selectDateRange");
  const [internalValue, setInternalValue] = useState(defaultValue);
  const committedValue = value !== undefined ? value : internalValue;
  const [isOpen, setIsOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  return (
    <Popover.Root open={isOpen} onOpenChange={setIsOpen} modal={false}>
      <Popover.Trigger disabled={isDisabled} aria-label={label} className={cx(triggerButtonClassName, className)}>
        <RiCalendarLine className="size-5 shrink-0 text-foreground-icon-primary" aria-hidden />
        <span className="flex items-center justify-center whitespace-nowrap px-1 text-body-medium text-text-primary">
          {committedValue ? `${formatTriggerDate(committedValue.start)} - ${formatTriggerDate(committedValue.end)}` : displayPlaceholder}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="end" className="bui-popup-layer">
          <Popover.Popup ref={popupRef} initialFocus={() => popupRef.current?.querySelector<HTMLElement>('[role="grid"] button[tabindex="0"]') ?? true} aria-label={label} className={popoverClassName}>
            <RangeEditor key={String(isOpen)} value={committedValue} label={label}
              onCancel={() => setIsOpen(false)} onApply={(next) => {
                if (value === undefined) setInternalValue(next);
                onChange?.(next);
                setIsOpen(false);
              }} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
