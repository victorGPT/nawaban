import assert from "node:assert/strict";
import test from "node:test";
import { CalendarDate } from "@internationalized/date";
import { daysInRange, formatChipDate, fromPickerDate, parseChipDate, toPickerDate } from "../components/base/date-picker/dates.ts";

test("date chips reject impossible dates instead of silently changing the chosen day", () => {
  for (const input of ["30/02/2026", "29/02/2025", "31/04/2026", "00/01/2026", "01/13/2026", "2026-09-13", "01/01/0000"]) {
    assert.equal(parseChipDate(input), null, input);
  }
  assert.equal(parseChipDate("29/02/2024")?.toString(), "2024-02-29");
  assert.equal(parseChipDate(" 3/9/2026 ")?.toString(), "2026-09-03");
});

test("DayPicker conversion preserves CalendarDate values including years below 100", () => {
  for (const date of [new CalendarDate(2026, 3, 8), new CalendarDate(2026, 11, 1), new CalendarDate(2024, 2, 29), new CalendarDate(25, 1, 1)]) {
    assert.equal(fromPickerDate(toPickerDate(date)).toString(), date.toString());
    assert.equal(toPickerDate(date).getHours(), 12);
  }
  assert.equal(formatChipDate(new CalendarDate(2026, 9, 3)), "03/09/2026");
});

test("inclusive range day counts use calendar days across DST, leap days, and years", () => {
  assert.equal(daysInRange({ start: new CalendarDate(2026, 3, 7), end: new CalendarDate(2026, 3, 9) }), 3);
  assert.equal(daysInRange({ start: new CalendarDate(2026, 10, 31), end: new CalendarDate(2026, 11, 2) }), 3);
  assert.equal(daysInRange({ start: new CalendarDate(2024, 2, 28), end: new CalendarDate(2024, 3, 1) }), 3);
  assert.equal(daysInRange({ start: new CalendarDate(2025, 12, 31), end: new CalendarDate(2026, 1, 1) }), 2);
  assert.equal(daysInRange({ start: new CalendarDate(2026, 9, 13), end: new CalendarDate(2026, 9, 13) }), 1);
});
