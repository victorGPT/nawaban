import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import App from "@/App";
import { Notices } from "@/components/NawabanUI";
import { TaskDetailSheet } from "@/views/task-detail";
import { setLocale } from "@/i18n";
import en from "@/i18n/en.json";
import zh from "@/i18n/zh-CN.json";
import { fetchBoard, fetchProjects, fetchTask } from "@/lib/api";
import type { BoardResponse, TaskDetail } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  fetchBoard: vi.fn(), fetchProjects: vi.fn(), fetchTask: vi.fn(),
}));

const task: TaskDetail = {
  id: "DEMO-I18N-001", title: "Example task title", status: "open", project: "example",
  session: null, created_at: 1, parent: null, children: [], blocked_by: [], dependents: [],
  body: "User-authored context\n\n## Acceptance criteria\n- A visible outcome",
  latest_note: { kind: "note", body: "Current user-authored progress", author: "agent", at: 1 },
  decisions: [], links: [], events: [],
};
const board: BoardResponse = {
  columns: [{ key: "open", tasks: [{
    id: task.id, title: task.title, status: "open", project: "example", parent: null,
    session: null, created_at: 1, active_at: 1, open_blockers: 0,
  }] }],
};

beforeEach(() => {
  vi.mocked(fetchBoard).mockResolvedValue(board);
  vi.mocked(fetchProjects).mockResolvedValue({ projects: [] });
  vi.mocked(fetchTask).mockResolvedValue(task);
});

test("the sidebar language control updates the mounted board", async () => {
  const user = userEvent.setup();
  render(<Notices><App /></Notices>);
  await screen.findByRole("heading", { name: new RegExp(zh.unassigned) });
  expect(screen.getByRole("heading", { name: zh.board, level: 1 })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  expect(screen.getByRole("heading", { name: en.board, level: 1 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: new RegExp(en.unassigned) })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: new RegExp(zh.unassigned) })).toBeNull();
  expect(localStorage.getItem("nawaban.locale")).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByText(task.title)).toBeTruthy();

});

test("the search shortcut focuses the board search", async () => {
  const user = userEvent.setup();
  const { container } = render(<Notices><App /></Notices>);
  await screen.findByText(task.title);
  expect(container.querySelector(".search-shortcut")!.textContent).toBe("/");
  await user.keyboard("/");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: zh.searchTasks }));
});

test("a mounted detail sheet translates immediately while preserving task content and loaded data", async () => {
  render(<Notices><TaskDetailSheet taskId={task.id} onSelectTask={() => {}} onOpenChange={() => {}} /></Notices>);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("User-authored context");
  expect(within(dialog).getByText(zh.context)).toBeTruthy();
  const requestsBefore = vi.mocked(fetchTask).mock.calls.length;

  act(() => setLocale("en"));
  expect(within(dialog).getByText(en.context)).toBeTruthy();
  expect(within(dialog).getByText(en.criteria)).toBeTruthy();
  expect(within(dialog).getByText(en.currentProgress)).toBeTruthy();
  expect(within(dialog).queryByText(zh.context)).toBeNull();
  expect(within(dialog).getByText("User-authored context")).toBeTruthy();
  expect(within(dialog).getByText("A visible outcome")).toBeTruthy();
  expect(within(dialog).getByText(task.title)).toBeTruthy();
  expect(vi.mocked(fetchTask).mock.calls.length).toBe(requestsBefore);
});

test("the rendered language switch remains usable when browser storage rejects writes", async () => {
  const user = userEvent.setup();
  render(<Notices><App /></Notices>);
  await screen.findByRole("heading", { name: new RegExp(zh.unassigned) });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage is disabled", "SecurityError");
  });
  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  expect(screen.getByRole("heading", { name: en.board, level: 1 })).toBeTruthy();
  expect(document.documentElement.lang).toBe("en");
  await user.click(screen.getByRole("button", { name: en.switchLanguage }));
  expect(screen.getByRole("heading", { name: zh.board, level: 1 })).toBeTruthy();
  expect(document.documentElement.lang).toBe("zh-CN");
});

test("sidebar toggles restore focus to the visible control in both directions", async () => {
  const user = userEvent.setup();
  render(<Notices><App /></Notices>);
  await screen.findByText(task.title);
  await user.click(screen.getByRole("button", { name: zh.toggleSidebar }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: zh.toggleSidebar }));
  expect(screen.queryByRole("complementary", { name: zh.mainNavigation })).toBeNull();
  await user.keyboard("[[");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: zh.toggleSidebar }));
  expect(screen.getByRole("complementary", { name: zh.mainNavigation })).toBeTruthy();
});
