import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TaskCard, type TaskCardData } from "@/components/TaskCard";
import { setLocale } from "@/i18n";
import { TASK_STALE_THRESHOLDS as thresholds } from "@/lib/task-staleness";

const now = 1800000000;
const task: TaskCardData = {
  id: "TASK-1", title: "Example task", status: "in_progress", project: "example", active_at: now,
};
function card(overrides: Partial<TaskCardData> = {}, onSelect = vi.fn(), fields: string[] = []) {
  return <TaskCard task={{ ...task, ...overrides }} onSelect={onSelect} fields={fields} />;
}
afterEach(() => vi.restoreAllMocks());

test("the date changes colour after three idle days and turns critical after seven", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  setLocale("zh-CN");
  const { container, rerender } = render(card({ active_at: now - thresholds.warning + 1 }));
  expect(container.querySelector(".task-date")).toBeTruthy();
  expect(container.querySelector("[data-stale-level]")).toBeNull();
  for (const [age, level] of [
    [thresholds.warning, "warning"], [thresholds.critical - 1, "warning"], [thresholds.critical, "critical"],
  ] as const) {
    rerender(card({ active_at: now - age }));
    expect(container.querySelector(`.task-date[data-stale-level="${level}"]`)).toBeTruthy();
  }
  expect(screen.getByTitle("7 天没动静")).toBeTruthy();
  act(() => setLocale("en"));
  expect(screen.getByTitle("No updates for 7 days")).toBeTruthy();
});

test("the card shows its project as text, a muted placeholder without one, and never the task id", () => {
  setLocale("zh-CN");
  const { container, rerender } = render(card({}, vi.fn(), ["id", "project"]));
  expect(container.querySelector(".task-module")?.textContent).toBe("example");
  expect(container.querySelector(".task-card")?.textContent).not.toContain("TASK-1");
  rerender(card({ project: null }, vi.fn(), ["id", "project"]));
  expect(container.querySelector(".task-module[data-ungrouped]")).toBeTruthy();
  rerender(card({}, vi.fn(), ["id"]));
  expect(container.querySelector(".task-module")).toBeNull();
});

test("open, closed and absent or future timestamps do not manufacture inactivity", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const { container, rerender } = render(card());
  for (const overrides of [
    { active_at: undefined }, { active_at: now + 60 },
    { status: "open", active_at: 1 }, { status: "done", active_at: 1 }, { status: "cancelled", active_at: 1 },
  ] as const) {
    rerender(card(overrides));
    expect(container.querySelector("[data-stale-level]")).toBeNull();
  }
});

test("new activity clears the stale badge while the card remains keyboard operable", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  setLocale("zh-CN");
  const user = userEvent.setup(), onSelect = vi.fn();
  const { container, rerender } = render(card({ active_at: now - thresholds.warning }, onSelect));
  expect(screen.getByTitle("3 天没动静")).toBeTruthy();
  rerender(card({ active_at: now }, onSelect));
  expect(container.querySelector("[data-stale-level]")).toBeNull();
  screen.getByRole("button", { name: "查看 TASK-1 Example task" }).focus();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledOnce();
});

test("one shared clock advances idle cards without a fetch and is cleaned up on unmount", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
  const { container, unmount } = render(<>{card({ active_at: now - thresholds.warning + 30 })}
    {card({ id: "TASK-2", active_at: now - thresholds.warning + 30 })}</>);
  expect(container.querySelectorAll("[data-stale-level]")).toHaveLength(0);
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelectorAll("[data-stale-level]")).toHaveLength(2);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
