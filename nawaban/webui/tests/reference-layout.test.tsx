import { act, render, screen, within, waitFor } from "@testing-library/react";
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
  expect(screen.getByRole("status").textContent).toContain(zh.boardSyncFailed);
  expect(screen.getByRole("status").textContent).not.toContain(zh.loadingTasks);
  expect(screen.getByText("Search controls")).toBeTruthy();
  expect(screen.getByText("Date controls")).toBeTruthy();
});

test("toolbar filters waiting items, reports the visible scope, and translates immediately", async () => {
  const user = userEvent.setup();
  const waitingBoard = structuredClone(board);
  waitingBoard.columns[1].tasks[0].waiting_on = "decision";
  vi.mocked(fetchBoard).mockResolvedValue(waitingBoard);
  const { container, rerender } = render(<BoardKanban project="workos" range={null} query=""
    onSelectTask={() => {}} onDecision={() => {}} decisionTasks={new Set()} />);
  await screen.findByText("Task claimed");
  const source = container.querySelector(".board-source-line")!;
  expect(source.textContent).toContain(`workos / ${zh.allEpics} · 5 张任务`);
  expect(source.textContent).toContain("每 30 秒刷新");
  expect(container.querySelector(".board-sync-time")!.closest('[role="status"]')).toBeNull();
  const filter = screen.getByRole("button", { name: zh.filterWaiting });
  await user.click(filter);
  await user.click(await screen.findByRole("menuitem", { name: zh.waitDecision }));
  expect(container.querySelectorAll("[data-card-id]")).toHaveLength(1);
  expect(source.textContent).toContain("1 张任务");
  await waitFor(() => expect(document.activeElement).toBe(filter));
  await user.click(filter);
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(filter));
  await user.click(screen.getByRole("combobox", { name: zh.filterEpic }));
  await user.click(await screen.findByRole("option", { name: "Example", exact: true }));
  expect(source.textContent).toContain("workos / Example · 1 张任务");
  await user.click(screen.getByRole("button", { name: zh.toggleCompact }));
  expect(container.querySelector(".board-compact")).toBeTruthy();
  act(() => setLocale("en"));
  expect(screen.getByRole("button", { name: en.toggleCompact }).getAttribute("aria-pressed")).toBe("true");
  expect(source.textContent).toContain("Refresh every 30 seconds");
  rerender(<BoardKanban project="workos" range={null} query="no-match"
    onSelectTask={() => {}} onDecision={() => {}} decisionTasks={new Set()} />);
  expect(source.textContent).toContain("0 tasks");
});

test("manual refresh exposes pending and failure states and can recover without changing layout", async () => {
  const user = userEvent.setup();
  const { container } = render(<BoardKanban project="" range={null} query=""
    onSelectTask={() => {}} onDecision={() => {}} decisionTasks={new Set()} />);
  await screen.findByText("Task claimed");
  expect(container.querySelector(".board-source-line")!.textContent).toContain(zh.noProject);
  await user.click(screen.getByRole("button", { name: zh.list, exact: true }));
  let reject!: (reason: Error) => void;
  vi.mocked(fetchBoard).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  const refresh = screen.getByRole("button", { name: zh.refreshTasks });
  await user.click(refresh);
  expect(refresh.hasAttribute("disabled")).toBe(true);
  expect(container.querySelector(".board-sync-time")!.textContent).toContain(zh.syncingTasks);
  await act(async () => reject(new Error("offline")));
  expect(container.querySelector(".board-sync-time")!.textContent).toContain(zh.boardSyncFailed);
  expect(container.querySelector(".board-sync-time")!.textContent).not.toContain("同步于");
  let resolve!: (value: BoardResponse) => void;
  vi.mocked(fetchBoard).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await user.click(refresh);
  expect(container.querySelector(".board-sync-time")!.textContent).toContain(zh.syncingTasks);
  await act(async () => resolve(board));
  await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
  expect(container.querySelector(".board-sync-time")!.textContent).toContain("同步于");
});
