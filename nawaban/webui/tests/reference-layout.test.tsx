import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { BoardKanban } from "@/components/BoardKanban";
import { fetchBoard } from "@/lib/api";
import { setLocale } from "@/i18n";
import zh from "@/i18n/zh-CN.json";
import en from "@/i18n/en.json";
import type { BoardResponse } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(), fetchBoard: vi.fn(),
}));
const states = ["open", "claimed", "in_progress", "staging-verified", "done"];
const board = {
  columns: states.map((status) => ({ key: status, title: status, color: "gray", tasks: [{
    id: `EXAMPLE-${status}`, title: `Task ${status}`, status, waiting_on: null,
    owner: null, epic: "Example", now: null, created_at: 1, started_at: null,
    completed_at: null, active_at: 1, fold: "EXAMPLE",
  }] })),
  liveness: { available: false, complete: true, busy_window_s: 120, idle_window_s: 300 },
} as BoardResponse;
beforeEach(() => { vi.mocked(fetchBoard).mockResolvedValue(board); });

test("four lanes keep all five lifecycle states, explicit Assigned labels, and independent decision actions", async () => {
  const user = userEvent.setup();
  const open = vi.fn(), decide = vi.fn();
  const { container } = render(<BoardKanban project={null} range={null} query=""
    onSelectTask={open} onDecision={decide} decisionTasks={new Set(["EXAMPLE-claimed"])} />);
  await screen.findByText("Task claimed");
  expect(container.querySelectorAll(".board-column")).toHaveLength(4);
  expect(container.querySelectorAll("[data-card-id]")).toHaveLength(5);
  const active = container.querySelector('[data-stage="in_progress"]') as HTMLElement;
  expect(within(active).getByText("Task claimed")).toBeTruthy();
  expect(within(active).getByText("Task in_progress")).toBeTruthy();
  expect(within(active).getByText(zh.assigned)).toBeTruthy();
  await user.click(within(active).getByRole("button", { name: zh.signalDecision }));
  expect(decide).toHaveBeenCalledWith("EXAMPLE-claimed");
  expect(open).not.toHaveBeenCalled();
  act(() => setLocale("en"));
  expect(within(active).getByText(en.assigned)).toBeTruthy();
  expect(container.querySelectorAll("[data-card-id]")).toHaveLength(5);
});

test("grouped list retains every task and keyboard traversal across lane headings", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(<BoardKanban project={null} range={null} query="" onSelectTask={open}
    onDecision={() => {}} decisionTasks={new Set()} />);
  await screen.findByText("Task claimed");
  await user.click(screen.getByRole("button", { name: zh.list, exact: true }));
  expect(new URLSearchParams(location.search).get("layout")).toBe("list");
  const table = screen.getByRole("table", { name: zh.taskList });
  expect(within(table).getAllByRole("heading", { level: 2 })).toHaveLength(4);
  for (const state of states) expect(within(table).getByText(`Task ${state}`)).toBeTruthy();
  const first = within(table).getByRole("row", { name: "EXAMPLE-open Task open" });
  first.focus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(open).toHaveBeenLastCalledWith("EXAMPLE-claimed");
  await user.keyboard("{End}{Enter}");
  expect(open).toHaveBeenLastCalledWith("EXAMPLE-done");
});

test("a failed read keeps search and date controls available for recovery", async () => {
  vi.mocked(fetchBoard).mockRejectedValue(new Error("Read failed"));
  render(<BoardKanban project={null} range={null} query="" onSelectTask={() => {}}
    onDecision={() => {}} decisionTasks={new Set()}
    controls={<span>Search controls</span>} filters={<span>Date controls</span>} />);
  await screen.findByText("Error: Read failed");
  expect(screen.getByText("Search controls")).toBeTruthy();
  expect(screen.getByText("Date controls")).toBeTruthy();
});
