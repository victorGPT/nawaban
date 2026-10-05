import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TaskCard, type TaskCardData } from "@/components/TaskCard";
import { ModulesView } from "@/views/modules";
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

test("the date changes colour after three idle days and turns critical after seven", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
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
});

test("waiting reasons are visible without staleness and translate immediately", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const { rerender, container } = render(card({ waiting_on: "prod" }));
  for (const [waiting_on, label] of [["prod", "等上线"], ["observe", "等观察"], ["external", "等外部"]]) {
    rerender(card({ waiting_on }));
    expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelector("[data-stale-level]")).toBeNull();
  }
  rerender(card({ waiting_on: "external", active_at: now - thresholds.critical }));
  act(() => setLocale("en"));
  expect(screen.getByText("Waiting on external")).toBeTruthy();
  expect(screen.getByTitle("No updates for 7 days")).toBeTruthy();
});

test("a label is dropped when every neighbour in the column would carry it", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  setLocale("zh-CN");
  const { container, rerender } = render(card({ status: "open", active_at: now - thresholds.critical }));
  expect(container.querySelector("[data-task-attention], [data-stale-level]")).toBeNull();
  rerender(card({ status: "open", waiting_on: "external", active_at: now - thresholds.critical }));
  expect(screen.getByText("等外部")).toBeTruthy();
  rerender(card({ status: "staging-verified", waiting_on: "prod" }));
  expect(container.querySelector("[data-task-attention]")).toBeNull();
  rerender(card({ status: "staging-verified", waiting_on: "prod", active_at: now - thresholds.warning }));
  expect(container.querySelector("[data-task-attention]")).toBeNull();
  expect(screen.getByTitle("3 天没动静")).toBeTruthy();
});

test("a pending decision is one labelled button; an unknown window shows no signal", async () => {
  const user = userEvent.setup(), onDecision = vi.fn();
  const { container } = render(<TaskCard task={{ ...task, waiting_on: "decision" }} hasAsk={false}
    onSelect={vi.fn()} onDecision={onDecision} />);
  expect(container.querySelector("[data-task-attention]")).toBeNull();
  await user.click(screen.getByRole("button", { name: "等你拍板" }));
  expect(onDecision).toHaveBeenCalledOnce();
  expect(screen.getByText("等你拍板")).toBeTruthy();
  const plain = render(card());
  expect(plain.container.querySelector(".signal-button, .task-decision")).toBeNull();
});

test("the card shows its module as text, a muted placeholder when ungrouped, and never the task id", () => {
  setLocale("zh-CN");
  const { container, rerender } = render(<TaskCard task={task} fields={["id", "module"]} hasAsk={false}
    onSelect={vi.fn()} onDecision={vi.fn()} />);
  expect(container.querySelector(".task-module")?.textContent).toBe("Example");
  expect(container.querySelector(".task-card")?.textContent).not.toContain("TASK-1");
  for (const epic of [null, "n/a"]) {
    rerender(<TaskCard task={{ ...task, epic }} fields={["id", "module"]} hasAsk={false}
      onSelect={vi.fn()} onDecision={vi.fn()} />);
    expect(container.querySelector(".task-module[data-ungrouped]")?.textContent).toBe("未分组");
  }
});

test("terminal tasks and absent or future timestamps do not manufacture inactivity", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const { container, rerender } = render(card());
  for (const overrides of [
    { active_at: undefined }, { active_at: now + 60 },
    { status: "done", active_at: 1, waiting_on: "observe" },
    { status: "cancelled", active_at: 1, waiting_on: "external" },
  ]) {
    rerender(card(overrides));
    expect(container.querySelector("[data-task-attention], [data-stale-level]")).toBeNull();
  }
  rerender(card({ active_at: undefined, waiting_on: "prod" }));
  expect(screen.getByText("等上线")).toBeTruthy();
});

test("new activity clears the stale badge while the card remains keyboard operable", async () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const user = userEvent.setup(), onSelect = vi.fn();
  const { container, rerender } = render(card({ active_at: now - thresholds.warning }, onSelect));
  expect(screen.getByTitle("3 天没动静")).toBeTruthy();
  rerender(card({ active_at: now }, onSelect));
  expect(container.querySelector("[data-stale-level]")).toBeNull();
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
  expect(await screen.findByText("等观察")).toBeTruthy();
  expect(screen.getByTitle("3 天没动静")).toBeTruthy();
});

test("a done card broken by a later change shows a red mark naming its fix, on the board and in modules", async () => {
  setLocale("zh-CN");
  const { container, rerender, unmount } = render(card({ status: "done" }));
  expect(container.querySelector("[data-task-regressed]")).toBeNull();
  rerender(card({ status: "done", regressed_by: ["FIX-1", "FIX-2"] }));
  expect(screen.getByText("回退").getAttribute("title")).toBe("后来的改动弄坏了这次交付。修复卡:FIX-1, FIX-2");
  act(() => setLocale("en"));
  expect(screen.getByText("Regressed")).toBeTruthy();
  act(() => setLocale("zh-CN"));
  unmount();
  vi.mocked(fetchModules).mockResolvedValue({ tasks: [{
    i: "SHIPPED", t: "Shipped task", s: "done", e: "Example", rb: ["FIX-1"],
  }], deps: [] });
  render(<ModulesView project={null} query="" decisionTasks={new Set()}
    onSelectTask={vi.fn()} onDecision={vi.fn()} />);
  expect((await screen.findByText("回退")).getAttribute("title")).toContain("FIX-1");
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

test("unknown waiting values remain visible in one footer chip without adding a content row", () => {
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);
  const unknown = "waiting_for_a_very_long_external_identifier";
  const { container, rerender } = render(card({ waiting_on: unknown, active_at: now - thresholds.warning }));
  expect(screen.getByText(unknown)).toBeTruthy();
  expect(container.querySelectorAll(".task-card-footer [data-task-attention]")).toHaveLength(1);
  expect(container.querySelector(".task-card-open [data-task-attention]")).toBeNull();
  act(() => setLocale("en"));
  expect(screen.getByTitle("No updates for 3 days")).toBeTruthy();
  rerender(card({ waiting_on: unknown }));
  expect(screen.getByText(unknown)).toBeTruthy();
  expect(container.querySelectorAll(".task-card-footer [data-task-attention]")).toHaveLength(1);
});
