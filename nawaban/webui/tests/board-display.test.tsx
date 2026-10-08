import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { BoardKanban } from "@/views/board";
import { BoardFilterBar } from "@/components/BoardFilterBar";
import { fetchBoard } from "@/lib/api";
import { BOARD_DISPLAY_STORAGE } from "@/lib/board-display";
import { BOARD_COLUMNS } from "@/lib/nawaban-model";
import zh from "@/i18n/zh-CN.json";
import { setLocale } from "@/i18n";
import type { BoardResponse } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(), fetchBoard: vi.fn(),
}));
const board: BoardResponse = {
  columns: ["open", "claimed", "in_progress", "staging-verified", "done"].map((status, i) => ({
    key: status, title: status, color: "gray", tasks: [{
      id: `TASK-${status}`, title: `Title ${status}`, status, waiting_on: null,
      owner: null, epic: "Example", now: null, created_at: i, started_at: null,
      completed_at: null, active_at: i, fold: "TASK",
    }],
  })),
  liveness: { available: false, complete: true, busy_window_s: 120, idle_window_s: 300 },
};
beforeEach(() => vi.mocked(fetchBoard).mockResolvedValue(board));
const props = { project: null, range: null, query: "", onSelectTask: vi.fn(),
  onDecision: vi.fn(), decisionTasks: new Set<string>() };

test("an invalid column URL cannot persist an empty board on a later clean visit", async () => {
  history.replaceState(null, "", "/?boardColumns=unknown");
  const first = render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  expect(first.container.querySelectorAll(".board-column")).toHaveLength(4);
  expect(new URLSearchParams(localStorage.getItem(BOARD_DISPLAY_STORAGE)!).get("boardColumns"))
    .toBe("open,in_progress,staging-verified,done");
  first.unmount();
  history.replaceState(null, "", "/");
  const revisit = render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  expect(revisit.container.querySelectorAll(".board-column")).toHaveLength(4);
});

test("an invalid field URL keeps both optional fields visible on a later clean visit", async () => {
  history.replaceState(null, "", "/?boardFields=zzz");
  const first = render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  const card = first.container.querySelector('[data-card-id="TASK-open"]')!;
  expect(card.textContent).not.toContain("TASK-open");
  expect(card.querySelector(".task-module")?.textContent).toBe("Example");
  expect(new URLSearchParams(localStorage.getItem(BOARD_DISPLAY_STORAGE)!).get("boardFields")).toBe("id,module");
  first.unmount();
  history.replaceState(null, "", "/");
  const revisit = render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  const restored = revisit.container.querySelector('[data-card-id="TASK-open"]')!;
  expect(restored.querySelector(".task-module")?.textContent).toBe("Example");
});

test("restore-all is disabled when nothing is hidden and the English count works for one or more lanes", async () => {
  setLocale("en");
  const user = userEvent.setup();
  render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  await user.click(screen.getByRole("button", { name: "Display" }));
  const restore = screen.getByRole("button", { name: "Show all columns" }) as HTMLButtonElement;
  expect(restore.disabled).toBe(true);
  await user.click(screen.getByRole("checkbox", { name: BOARD_COLUMNS[0].label }));
  expect(restore.disabled).toBe(false);
  expect(screen.getByText("Hidden columns: 1 · Restore them in Display")).toBeTruthy();
  await user.click(screen.getByRole("checkbox", { name: BOARD_COLUMNS[1].label }));
  expect(screen.getByText("Hidden columns: 2 · Restore them in Display")).toBeTruthy();
  await user.click(restore);
  expect(restore.disabled).toBe(true);
  expect(screen.queryByText(/Hidden columns:/)).toBeNull();
});

test("hiding a lane persists locally and in the URL without filtering tasks or refetching", async () => {
  const user = userEvent.setup();
  history.replaceState(null, "", "/?project=workos&task=TASK-open");
  const view = render(<BoardKanban {...props} />);
  await screen.findByText("Title claimed");
  await user.click(screen.getByRole("button", { name: zh.boardDisplay }));
  await user.click(screen.getByRole("checkbox", { name: zh.inProgress }));
  expect(view.container.querySelectorAll(".board-column")).toHaveLength(3);
  expect((view.container.querySelector(".kanban") as HTMLElement).style.getPropertyValue("--board-column-count")).toBe("3");
  expect(screen.queryByText("Title claimed")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("5 张任务");
  expect(fetchBoard).toHaveBeenCalledTimes(1);
  expect(board.columns.flatMap((column) => column.tasks)).toHaveLength(5);
  const params = new URLSearchParams(location.search);
  expect(params.get("boardColumns")).toBe("open,staging-verified,done");
  expect(params.get("project")).toBe("workos");
  expect(params.get("task")).toBe("TASK-open");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: zh.list, exact: true }));
  expect(screen.getByText("Title claimed")).toBeTruthy();
  expect(screen.getByText("Title in_progress")).toBeTruthy();
  view.unmount();
  history.replaceState(null, "", "/");
  const restored = render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  expect(restored.container.querySelectorAll(".board-column")).toHaveLength(3);
  expect(screen.queryByText("Title claimed")).toBeNull();
});

test("URL overrides local preferences; an explicit empty list can be recovered", async () => {
  localStorage.setItem(BOARD_DISPLAY_STORAGE, "boardColumns=open&boardFields=id&boardDensity=compact");
  history.replaceState(null, "", "/?boardColumns=&boardFields=&boardDensity=comfortable");
  const user = userEvent.setup();
  const { container } = render(<BoardKanban {...props} />);
  await screen.findByText(zh.boardNoColumns);
  expect(container.querySelector(".board-compact")).toBeNull();
  await user.click(screen.getByRole("button", { name: zh.boardShowAllColumns }));
  expect(container.querySelectorAll(".board-column")).toHaveLength(4);
  expect(screen.getByText("Title claimed")).toBeTruthy();
  expect(screen.getByText(zh.assigned)).toBeTruthy();
  expect(container.querySelector(".task-module")).toBeNull();
  expect(container.querySelectorAll(".signal-button")).toHaveLength(0);
});

test("display controls sort within lanes and hide fields in board and list", async () => {
  const user = userEvent.setup();
  const { container } = render(<BoardKanban {...props} />);
  await screen.findByText("Title claimed");
  const display = screen.getByRole("button", { name: zh.boardDisplay });
  await user.click(display);
  await user.click(screen.getByRole("combobox", { name: zh.boardSort }));
  await user.click(await screen.findByRole("option", { name: zh.boardSort_created }));
  const lane = container.querySelector('[data-stage="in_progress"]')!;
  expect([...lane.querySelectorAll("[data-card-id]")].map((el) => el.getAttribute("data-card-id")))
    .toEqual(["TASK-in_progress", "TASK-claimed"]);
  await user.click(screen.getByRole("checkbox", { name: zh.taskId }));
  await user.click(screen.getByRole("checkbox", { name: zh.epicName }));
  await user.click(screen.getByRole("checkbox", { name: zh.boardCompact }));
  expect(container.querySelector(".task-module")).toBeNull();
  expect(container.querySelector(".board-compact")).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(display));
  await user.click(screen.getByRole("button", { name: zh.list, exact: true }));
  expect(screen.getAllByRole("columnheader")).toHaveLength(2);
  expect(screen.getByText(zh.assigned)).toBeTruthy();
  expect(new URLSearchParams(location.search).get("boardFields")).toBe("");
});

test("display panel supports keyboard toggling, Escape and outside dismissal", async () => {
  const user = userEvent.setup();
  render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  const trigger = screen.getByRole("button", { name: zh.boardDisplay });
  trigger.focus();
  await user.keyboard("{Enter}");
  const panel = await screen.findByRole("dialog", { name: zh.boardDisplay });
  const compact = within(panel).getByRole("checkbox", { name: zh.boardCompact });
  compact.focus();
  await user.keyboard(" ");
  expect(compact.getAttribute("aria-checked")).toBe("true");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: zh.list, exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("filter panel retains nested date and module controls after selection", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<BoardKanban {...props} filters={<BoardFilterBar range={null} onChange={change} />} />);
  await user.click(screen.getByRole("button", { name: zh.boardFilter }));
  await user.click(screen.getByRole("button", { name: zh.today }));
  expect(change).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog", { name: zh.boardFilter })).toBeTruthy();
  await user.click(screen.getByRole("combobox", { name: zh.filterEpic }));
  await screen.findByRole("listbox");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: zh.boardFilter })).toBeTruthy();
  const dates = screen.getByRole("button", { name: zh.customUpdatedRange });
  await user.click(dates);
  await screen.findByRole("dialog", { name: zh.customUpdatedRange });
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(dates));
  expect(screen.getByRole("dialog", { name: zh.boardFilter })).toBeTruthy();
});

test("denied local storage does not prevent display updates or URL persistence", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  const user = userEvent.setup();
  render(<BoardKanban {...props} />);
  await screen.findByText("Title open");
  await user.click(screen.getByRole("button", { name: zh.boardDisplay }));
  await user.click(screen.getByRole("checkbox", { name: BOARD_COLUMNS[2].label }));
  expect(new URLSearchParams(location.search).get("boardColumns")).toBe("open,in_progress,done");
});
