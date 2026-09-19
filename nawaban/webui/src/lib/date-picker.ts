import { CalendarDate, getLocalTimeZone } from "@internationalized/date";

// Noon keeps local calendar days stable across daylight-saving transitions.
export function toPickerDate(date: CalendarDate): Date {
  const result = date.toDate(getLocalTimeZone());
  result.setHours(12, 0, 0, 0);
  return result;
}

export function fromPickerDate(date: Date): CalendarDate {
  return new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function formatChipDate(date: CalendarDate): string {
  return `${String(date.day).padStart(2, "0")}/${String(date.month).padStart(2, "0")}/${date.year}`;
}

export function parseChipDate(text: string): CalendarDate | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const date = new CalendarDate(year, month, day);
  return date.year === year && date.month === month && date.day === day ? date : null;
}

export function daysInRange(value: { start: CalendarDate; end: CalendarDate }): number {
  return value.end.calendar.toJulianDay(value.end) - value.start.calendar.toJulianDay(value.start) + 1;
}
