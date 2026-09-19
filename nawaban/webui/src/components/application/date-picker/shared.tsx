"use client";

import { useEffect, useState } from "react";
import { DayButton, type DayButtonProps, type DayPickerProps } from "@daypicker/react";
import { enUS, zhCN } from "@daypicker/react/locale";
import { RiArrowLeftSLine, RiArrowRightSLine } from "@remixicon/react";
import type { CalendarDate } from "@internationalized/date";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { cx } from "@/utils/cx";
import { getLocale, useLocale } from "@/i18n";
import { formatChipDate, parseChipDate, toPickerDate } from "@/lib/date-picker";

export { formatChipDate, parseChipDate } from "@/lib/date-picker";

export function formatTriggerDate(date: CalendarDate) {
  return new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric", year: "numeric" }).format(toPickerDate(date));
}

function CalendarDayButton({ modifiers, day, children, ...props }: DayButtonProps) {
  const start = modifiers.range_start;
  const end = modifiers.range_end;
  const selected = modifiers.selected;
  const range = start || end || modifiers.range_middle;
  const single = selected && (!range || (start && end));
  const weekday = day.date.getDay();
  return (
    <DayButton {...props} day={day} modifiers={modifiers}>
      <span aria-hidden className={cx(
        "pointer-events-none absolute inset-y-0 bg-date-range-background transition-opacity duration-100",
        start ? "left-1/2" : weekday === 0 ? "left-0 rounded-l-lg" : "-left-1.5",
        end ? "right-1/2" : weekday === 6 ? "right-0 rounded-r-lg" : "-right-1.5",
        range && !single ? "opacity-100" : "opacity-0",
      )} />
      <span aria-hidden className={cx(
        "pointer-events-none absolute inset-0 bg-date-range-edge-background",
        single && "rounded-lg", start && !single && "rounded-l-lg", end && !single && "rounded-r-lg",
        single || start || end ? "opacity-100" : "opacity-0",
      )} />
      <span className="relative">{children}</span>
    </DayButton>
  );
}

/**
 * App composition: shadcn's Calendar wearing the BoardUI skin. The day picker
 * owns navigation and range selection; every slot class below is the Figma
 * recipe, replacing nova's defaults.
 */
export function BoardCalendar(props: DayPickerProps) {
  const locale = useLocale();
  return (
    <Calendar
      className="bg-transparent p-0"
      locale={locale === "zh-CN" ? zhCN : enUS}
      weekStartsOn={0}
      navLayout="around"
      components={{
        DayButton: CalendarDayButton,
        Chevron: ({ orientation, className }) => orientation === "left"
          ? <RiArrowLeftSLine className={cx("size-4", className)} aria-hidden />
          : <RiArrowRightSLine className={cx("size-4", className)} aria-hidden />,
      }}
      classNames={{
        root: "relative",
        months: "relative flex flex-col gap-2 sm:flex-row",
        month: "relative w-[326px] shrink-0 rounded-2xl bg-background-primary-default p-[15px] shadow-xs",
        month_caption: "mb-5 flex h-4 items-center justify-center text-body-medium text-text-primary",
        caption_label: "text-center",
        button_previous: "absolute left-[15px] top-[15px] z-10 flex size-4 items-center justify-center rounded text-text-secondary outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        button_next: "absolute right-[15px] top-[15px] z-10 flex size-4 items-center justify-center rounded text-text-secondary outline-none hover:bg-background-secondary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        month_grid: "-m-3 border-separate [border-spacing:12px_12px]",
        weekday: "size-8 p-0 text-center text-body-medium text-text-secondary",
        day: "size-8 p-0",
        day_button: "relative flex size-8 cursor-pointer items-center justify-center rounded-lg text-body-medium text-text-primary outline-none transition-colors hover:bg-background-secondary-hover focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        disabled: "pointer-events-none opacity-40",
        hidden: "invisible",
        outside: "text-text-tertiary",
      }}
      {...props}
    />
  );
}

/** Invalid edits revert; blur and Enter commit valid calendar dates only. */
export function DateChipInput({ date, label, onCommit }: {
  date: CalendarDate;
  label: string;
  onCommit: (date: CalendarDate) => void;
}) {
  const formatted = formatChipDate(date);
  const [text, setText] = useState(formatted);
  useEffect(() => { setText(formatted); }, [formatted]);
  return (
    <Input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const parsed = parseChipDate(text);
        if (parsed) onCommit(parsed);
        else setText(formatted);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setText(formatted);
      }}
      aria-label={label}
      className="h-auto w-[104px] rounded-2lg border-border-button-default bg-background-primary-default px-2 py-2 text-body-medium text-text-primary shadow-xs transition-colors duration-100 ease-out focus-visible:border-border-button-active focus-visible:ring-0"
    />
  );
}

export const popoverClassName = cx(
  "w-auto max-h-[var(--available-height)] max-w-[calc(100vw-16px)] gap-0 overflow-auto origin-top rounded-3xl bg-background-secondary-default p-0 shadow-dropdown ring-0 outline-none",
  "transition duration-150 ease-out",
  "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
  "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
);
