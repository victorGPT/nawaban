import { useRef, useState } from "react";
import { CalendarDate } from "@internationalized/date";
import { beforeEach, expect, test, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DatePicker } from "@/components/base/date-picker/date-picker";
import { DateRangePicker } from "@/components/base/date-picker/date-range-picker";
import { setLocale } from "@/i18n";
import en from "@/i18n/en.json";
import zh from "@/i18n/zh-CN.json";

beforeEach(() => setLocale("en"));

const original = { start: new CalendarDate(2026, 9, 10), end: new CalendarDate(2026, 9, 12) };

function dayButton(date: string) {
  const cell = screen.getByRole("dialog").querySelector(`[data-day="${date}"]`);
  expect(cell).not.toBeNull();
  return within(cell as HTMLElement).getByRole("button");
}

test("range edits are staged and Cancel restores the committed range on reopen", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<DateRangePicker defaultValue={original} onChange={changed} aria-label="Task dates" />);
  const opener = screen.getByRole("button", { name: "Task dates" });
  await user.click(opener);
  expect(screen.getAllByRole("grid")).toHaveLength(2);
  await user.click(dayButton("2026-09-15"));
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(dayButton("2026-09-18"));
  expect((screen.getByRole("textbox", { name: "Start date" }) as HTMLInputElement).value).toBe("15/09/2026");
  expect((screen.getByRole("textbox", { name: "End date" }) as HTMLInputElement).value).toBe("18/09/2026");
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(opener);
  expect((screen.getByRole("textbox", { name: "Start date" }) as HTMLInputElement).value).toBe("10/09/2026");
  expect((screen.getByRole("textbox", { name: "End date" }) as HTMLInputElement).value).toBe("12/09/2026");
  expect(changed).not.toHaveBeenCalled();
});

test("Apply commits a selected range exactly once and persists it on reopen", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<DateRangePicker defaultValue={original} onChange={changed} aria-label="Task dates" />);
  const opener = screen.getByRole("button", { name: "Task dates" });
  await user.click(opener);
  await user.click(dayButton("2026-09-15"));
  expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(dayButton("2026-09-18"));
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].start.toString()).toBe("2026-09-15");
  expect(changed.mock.calls[0][0].end.toString()).toBe("2026-09-18");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await user.click(opener);
  expect((screen.getByRole("textbox", { name: "Start date" }) as HTMLInputElement).value).toBe("15/09/2026");
  expect((screen.getByRole("textbox", { name: "End date" }) as HTMLInputElement).value).toBe("18/09/2026");
});

test("an impossible date edit reverts and Escape discards valid pending edits", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<DateRangePicker defaultValue={original} onChange={changed} aria-label="Task dates" />);
  const opener = screen.getByRole("button", { name: "Task dates" });
  await user.click(opener);
  const start = screen.getByRole("textbox", { name: "Start date" });
  await user.clear(start);
  await user.type(start, "30/02/2026");
  await user.tab();
  expect((start as HTMLInputElement).value).toBe("10/09/2026");
  await user.clear(start);
  await user.type(start, "11/09/2026");
  await user.tab();
  expect((start as HTMLInputElement).value).toBe("11/09/2026");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(changed).not.toHaveBeenCalled();
  await user.click(opener);
  expect((screen.getByRole("textbox", { name: "Start date" }) as HTMLInputElement).value).toBe("10/09/2026");
});

function ExternalDateExample({ onChange }: { onChange: (date: CalendarDate | null) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <><button ref={triggerRef} onClick={() => setOpen((value) => !value)}>Birthday</button>
    <DatePicker triggerRef={triggerRef} isOpen={open} onOpenChange={setOpen}
      defaultValue={new CalendarDate(2026, 9, 30)} onChange={onChange} aria-label="Birthday calendar" />
  </>;
}

test("external single-date trigger supports keyboard month crossing and focus restoration", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<ExternalDateExample onChange={changed} />);
  const opener = screen.getByRole("button", { name: "Birthday", exact: true });
  await user.click(opener);
  await waitFor(() => expect(document.activeElement).toBe(dayButton("2026-09-30")));
  await user.keyboard("{ArrowRight}{Enter}");
  expect((screen.getByRole("textbox", { name: "Date" }) as HTMLInputElement).value).toBe("01/10/2026");
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Apply" }));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].toString()).toBe("2026-10-01");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await user.click(opener);
  await user.click(opener);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("an open range editor translates its calendar and preserves an unapplied draft", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<DateRangePicker defaultValue={original} onChange={changed} />);
  const opener = screen.getByRole("button", { name: en.dateRange });
  const englishTrigger = opener.textContent;
  await user.click(opener);
  const englishMonth = screen.getAllByRole("grid")[0].getAttribute("aria-label");
  const englishWeekday = screen.getByRole("dialog").querySelector("th")!.textContent;
  await user.click(dayButton("2026-09-15"));
  await user.click(dayButton("2026-09-18"));

  act(() => setLocale("zh-CN"));
  expect(screen.getByRole("button", { name: zh.today })).toBeTruthy();
  expect(screen.queryByRole("button", { name: en.today })).toBeNull();
  expect(screen.getByRole("button", { name: zh.cancel })).toBeTruthy();
  expect(screen.getAllByRole("grid")[0].getAttribute("aria-label")).not.toBe(englishMonth);
  expect(screen.getByRole("dialog").querySelector("th")!.textContent).not.toBe(englishWeekday);
  expect(screen.getByRole("button", { name: zh.dateRange }).textContent).not.toBe(englishTrigger);
  expect((screen.getByRole("textbox", { name: zh.startDate }) as HTMLInputElement).value).toBe("15/09/2026");
  expect((screen.getByRole("textbox", { name: zh.endDate }) as HTMLInputElement).value).toBe("18/09/2026");
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: zh.apply }));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].start.toString()).toBe("2026-09-15");
  expect(changed.mock.calls[0][0].end.toString()).toBe("2026-09-18");
});

test("an open single-date editor translates without committing or discarding its draft", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  render(<ExternalDateExample onChange={changed} />);
  await user.click(screen.getByRole("button", { name: "Birthday", exact: true }));
  await user.click(dayButton("2026-09-15"));
  act(() => setLocale("zh-CN"));
  expect((screen.getByRole("textbox", { name: zh.date }) as HTMLInputElement).value).toBe("15/09/2026");
  expect(screen.getByRole("button", { name: zh.cancel })).toBeTruthy();
  expect(screen.queryByRole("button", { name: en.apply })).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: zh.apply }));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed.mock.calls[0][0].toString()).toBe("2026-09-15");
});
