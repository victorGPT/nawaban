import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TaskCard, type TaskCardData } from "@/components/TaskCard";
import { ModulesView } from "@/components/ModulesView";
import { fetchModules } from "@/lib/api";
import { setLocale } from "@/i18n";
import { TASK_STALE_THRESHOLDS as thresholds } from "@/lib/task-staleness";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(), fetchModules: vi.fn(),
}));
const now = 1800000000;
const task: TaskCardData = {
  id: "TASK-1", title: "Example task", status: "in_progress", epic: "Example",
  waiting_on: null, active_at: now,
};
function card(overrides: Partial<TaskCardData> = {}, onSelect = vi.fn()) {
  return <TaskCard task={{ ...task, ...overrides }} hasAsk={false}
    onSelect={onSelect} onDecision={vi.fn()} />;
}
afterEach(() => vi.restoreAllMocks());

test("the row appears at the threshold and becomes more prominent at each boundary", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const { container, rerender } = render(card({ active_at: now - thresholds.visible + 1 }));
  expect(container.querySelector("[data-task-attention]")).toBeNull();
  for (const [age, level, color] of [
    [thresholds.visible, "stale", "bg-background-secondary-default"],
    [thresholds.warning - 1, "stale", "bg-background-secondary-default"],
    [thresholds.warning, "warning", "bg-status-yellow-background"],
    [thresholds.critical - 1, "warning", "bg-status-yellow-background"],
    [thresholds.critical, "critical", "bg-status-rose-background"],
  ] as const) {
    rerender(card({ active_at: now - age }));
    expect(container.querySelector(`[data-stale-level="${level}"]`)?.classList.contains(color)).toBe(true);
  }
  expect(screen.getByText("7 天没动静")).toBeTruthy();
});

test("waiting reasons are visible without staleness and translate immediately", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const { rerender, container } = render(card({ waiting_on: "decision" }));
  for (const [waiting_on, label] of [["decision", "等你拍板"], ["prod", "等上线"],
    ["observe", "等观察"], ["external", "等外部"]]) {
    rerender(card({ waiting_on }));
    expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelector("[data-stale-level]")).toBeNull();
  }
  rerender(card({ waiting_on: "decision", active_at: now - thresholds.critical }));
  act(() => setLocale("en"));
  expect(screen.getByText("Waiting on decision")).toBeTruthy();
  expect(screen.getByText("No updates for 7 days")).toBeTruthy();
});

test("terminal tasks and absent or future timestamps do not manufacture inactivity", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const { container, rerender } = render(card());
  for (const overrides of [
    { active_at: undefined }, { active_at: now + 60 },
    { status: "done", active_at: 1, waiting_on: "decision" },
    { status: "cancelled", active_at: 1, waiting_on: "external" },
  ]) {
    rerender(card(overrides));
    expect(container.querySelector("[data-task-attention]")).toBeNull();
  }
  rerender(card({ active_at: undefined, waiting_on: "prod" }));
  expect(screen.getByText("等上线")).toBeTruthy();
});

test("new activity clears the stale badge while the card remains keyboard operable", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const user = userEvent.setup(), onSelect = vi.fn();
  const { container, rerender } = render(card({ active_at: now - thresholds.warning }, onSelect));
  expect(screen.getByText("3 天没动静")).toBeTruthy();
  rerender(card({ active_at: now }, onSelect));
  expect(container.querySelector("[data-task-attention]")).toBeNull();
  screen.getByRole("button", { name: "查看 TASK-1 Example task" }).focus();
  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledOnce();
});

test("module cards consume the API activity timestamp and waiting reason", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  vi.mocked(fetchModules).mockResolvedValue({ tasks: [{
    i: task.id, t: task.title, s: task.status, e: "Example", waiting_on: "observe",
    active_at: now - thresholds.warning,
  }], deps: [] });
  render(<ModulesView project={null} query="" decisionTasks={new Set()}
    onSelectTask={vi.fn()} onDecision={vi.fn()} />);
  expect(await screen.findByText("3 天没动静")).toBeTruthy();
  expect(screen.getByText("等观察")).toBeTruthy();
});

test("one shared clock advances idle cards without a fetch and is cleaned up on unmount", () => {
  vi.useFakeTimers();
  vi.setSystemTime(now * 1000);
  const { container, unmount } = render(<>{card({ active_at: now - thresholds.visible + 30 })}
    {card({ id: "TASK-2", active_at: now - thresholds.visible + 30 })}</>);
  expect(container.querySelectorAll("[data-task-attention]")).toHaveLength(0);
  act(() => vi.advanceTimersByTime(60_000));
  expect(container.querySelectorAll("[data-task-attention]")).toHaveLength(2);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
