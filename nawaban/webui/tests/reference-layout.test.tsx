import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { BoardKanban } from "@/views/board";
import { fetchBoard } from "@/lib/api";
import { setLocale } from "@/i18n";
import zh from "@/i18n/zh-CN.json";
import en from "@/i18n/en.json";
import type { BoardResponse } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(), fetchBoard: vi.fn(),
}));
const states = ["open", "in_progress", "done"] as const;
const board: BoardResponse = {
  columns: states.map((status) => ({ key: status, tasks: [{
    id: `EXAMPLE-${status}`, title: `Task ${status}`, status, project: "workos", parent: null,
    session: status === "in_progress" ? "session-1" : null, created_at: 1, active_at: 1, open_blockers: 0,
  }] })),
};
beforeEach(() => { vi.mocked(fetchBoard).mockResolvedValue(board); });

test("three lanes hold open, in-progress and done tasks and a card opens its task", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  const { container } = render(<BoardKanban project={null} range={null} query="" onSelectTask={open} />);
  await screen.findByText("Task in_progress");
  expect(container.querySelectorAll(".board-column")).toHaveLength(3);
  expect(container.querySelectorAll("[data-card-id]")).toHaveLength(3);
  const active = container.querySelector('[data-stage="in_progress"]') as HTMLElement;
  expect(within(active).getByRole("heading", { level: 2 }).textContent).toBe(`${zh.inProgress}1`);
  await user.click(within(active).getByRole("button", { name: /Task in_progress/ }));
  expect(open).toHaveBeenCalledWith("EXAMPLE-in_progress");
  act(() => setLocale("en"));
  expect(within(active).getByRole("heading", { level: 2 }).textContent).toBe(`${en.inProgress}1`);
});

test("grouped list retains every task and keyboard traversal across lane headings", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  render(<BoardKanban project={null} range={null} query="" onSelectTask={open} />);
  await screen.findByText("Task in_progress");
  await user.click(screen.getByRole("button", { name: zh.list, exact: true }));
  expect(new URLSearchParams(location.search).get("layout")).toBe("list");
  const table = screen.getByRole("table", { name: zh.taskList });
  expect(within(table).getAllByRole("heading", { level: 2 })).toHaveLength(3);
  for (const state of states) expect(within(table).getByText(`Task ${state}`)).toBeTruthy();
  const first = within(table).getByRole("row", { name: "EXAMPLE-open Task open" });
  first.focus();
  await user.keyboard("{ArrowDown}{Enter}");
  expect(open).toHaveBeenLastCalledWith("EXAMPLE-in_progress");
  await user.keyboard("{End}{Enter}");
  expect(open).toHaveBeenLastCalledWith("EXAMPLE-done");
});

test("a failed read keeps search and date controls available for recovery", async () => {
  vi.mocked(fetchBoard).mockRejectedValue(new Error("Read failed"));
  render(<BoardKanban project={null} range={null} query="" onSelectTask={() => {}}
    controls={<span>Search controls</span>} filters={<span>Date controls</span>} />);
  await screen.findByText("Error: Read failed");
  expect(screen.getByRole("status").textContent).toContain(zh.boardSyncFailed);
  expect(screen.getByRole("status").textContent).not.toContain(zh.loadingTasks);
  expect(screen.getByText("Search controls")).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: zh.boardFilter }));
  expect(screen.getByText("Date controls")).toBeTruthy();
});

test("the toolbar reports the visible scope, searches and translates immediately", async () => {
  const user = userEvent.setup();
  const { container, rerender } = render(<BoardKanban project="workos" range={null} query=""
    onSelectTask={() => {}} />);
  await screen.findByText("Task in_progress");
  const source = container.querySelector(".board-source-line")!;
  expect(source.textContent).toContain("workos · 3 张任务");
  expect(source.textContent).toContain("每 30 秒刷新");
  expect(container.querySelector(".board-sync-time")!.closest('[role="status"]')).toBeNull();
  await user.click(screen.getByRole("button", { name: zh.boardDisplay }));
  await user.click(screen.getByRole("checkbox", { name: zh.boardCompact }));
  expect(container.querySelector(".board-compact")).toBeTruthy();
  act(() => setLocale("en"));
  expect(screen.getByRole("checkbox", { name: en.boardCompact }).getAttribute("aria-checked")).toBe("true");
  expect(source.textContent).toContain("Refresh every 30 seconds");
  rerender(<BoardKanban project="workos" range={null} query="session-1" onSelectTask={() => {}} />);
  expect(container.querySelectorAll("[data-card-id]")).toHaveLength(1);
  rerender(<BoardKanban project="workos" range={null} query="no-match" onSelectTask={() => {}} />);
  expect(source.textContent).toContain("0 tasks");
});

test("manual refresh exposes pending and failure states and can recover without changing layout", async () => {
  const user = userEvent.setup();
  const { container } = render(<BoardKanban project="" range={null} query=""
    onSelectTask={() => {}} />);
  await screen.findByText("Task in_progress");
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
