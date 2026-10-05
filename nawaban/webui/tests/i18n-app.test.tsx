import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import App from "@/App";
import { Notices } from "@/components/NawabanUI";
import { TaskDetailSheet } from "@/views/task-detail";
import { setLocale } from "@/i18n";
import en from "@/i18n/en.json";
import zh from "@/i18n/zh-CN.json";
import { fetchBoard, fetchInbox, fetchKin, fetchModules, fetchProjects, fetchTask } from "@/lib/api";
import type { BoardResponse, InboxResponse, KinResponse, TaskDetail } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  fetchBoard: vi.fn(), fetchInbox: vi.fn(), fetchKin: vi.fn(),
  fetchModules: vi.fn(), fetchProjects: vi.fn(), fetchTask: vi.fn(),
}));

const task: TaskDetail = {
  id: "DEMO-I18N-001", title: "Example task title", status: "open", waiting_on: null,
  owner: null, epic: "EXAMPLE", now: "Current user-authored progress", created_at: 1,
  fold: "EXAMPLE", started_at: null, completed_at: null, active_at: 1,
  context: "User-authored context", adr: null, success: ["A visible outcome"],
  constraints: ["Preserve existing data"], touches: [], edges_out: [], edges_in: [],
  decisions: [], events: [], refs: [], sessions: [], letters: [],
};
const board: BoardResponse = {
  columns: [{ key: "open", title: "Backend status label", color: "gray", tasks: [task] }],
  liveness: { available: false, complete: true, busy_window_s: 120, idle_window_s: 300 },
};
const inbox: InboxResponse = {
  total: 1, oldest_days: 0, flow: { raised_7d: 1, closed_7d: 0 }, agent_side: 0,
  groups: [{ kind: "accept", title: "Backend ask label", items: [{
    id: 7, kind: "accept", question: "Review this result", evidence: "Observed example result",
    options: null, blast: null, hands_on: false, raised_at: 1, raised_by: "fixture",
    closed_at: null, closed_as: null, answer: null, decision_id: null,
    confidence: null, confidence_reason: null, stalled_days: 0, task_ids: [task.id],
  }] }],
};
const kin: KinResponse = {
  blocked_by: [], stuck_at: null, unblocks: [], epic: "EXAMPLE",
  lineage: { split_from: null, split_out: [], supersedes: [], superseded_by: [], latest_decision: null },
};

beforeEach(() => {
  vi.mocked(fetchBoard).mockResolvedValue(board);
  vi.mocked(fetchInbox).mockResolvedValue(inbox);
  vi.mocked(fetchProjects).mockResolvedValue({ projects: [] });
  vi.mocked(fetchModules).mockResolvedValue({
    tasks: [{ i: task.id, t: task.title, s: task.status, e: task.epic! }], deps: [],
  });
  vi.mocked(fetchTask).mockResolvedValue(task);
  vi.mocked(fetchKin).mockResolvedValue(kin);
});

test("the sidebar language control updates the mounted board, module network, and inbox", async () => {
  const user = userEvent.setup();
  render(<Notices><App /></Notices>);
  await screen.findByRole("heading", { name: new RegExp(zh.unassigned) });
  expect(screen.getByRole("link", { name: zh.board }).getAttribute("aria-current")).toBe("page");

  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  expect(screen.getByRole("heading", { name: en.board, level: 1 })).toBeTruthy();
  expect(screen.getByRole("heading", { name: new RegExp(en.unassigned) })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: new RegExp(zh.unassigned) })).toBeNull();
  expect(localStorage.getItem("nawaban.locale")).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  expect(screen.getByText(task.title)).toBeTruthy();

  await user.click(screen.getByRole("link", { name: en.epic }));
  await screen.findByRole("switch", { name: en.focusMode });
  await user.click(screen.getByRole("button", { name: en.switchLanguage }));
  expect(screen.getByRole("heading", { name: zh.epic, level: 1 })).toBeTruthy();
  expect(screen.getByRole("switch", { name: zh.focusMode })).toBeTruthy();
  expect(screen.getByText(task.title)).toBeTruthy();

  await user.click(screen.getByRole("link", { name: zh.inbox }));
  await screen.findByRole("button", { name: zh.acknowledge });
  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  expect(screen.getByRole("heading", { name: en.inbox, level: 1 })).toBeTruthy();
  expect(screen.getByRole("button", { name: en.acknowledge })).toBeTruthy();
  expect(screen.getByRole("button", { name: en.requestChanges })).toBeTruthy();
  expect(screen.queryByRole("button", { name: zh.acknowledge })).toBeNull();
  expect(screen.getAllByText("Review this result").length).toBeGreaterThan(0);
});

test("module cards retain blocked and cross-epic dependency tags without lifecycle badges", async () => {
  const user = userEvent.setup();
  vi.mocked(fetchModules).mockResolvedValue({ tasks: [
    { i: "CHILD", t: "Dependent task", s: "claimed", e: "A" },
    { i: "ROOT", t: "Upstream task", s: "open", e: "B" },
  ], deps: [["CHILD", "ROOT"]] });
  const { container } = render(<Notices><App /></Notices>);
  await screen.findByText(task.title);
  expect(container.querySelector(".search-shortcut")!.textContent).toBe("/");
  await user.keyboard("/");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: zh.searchTasks }));
  await user.click(screen.getByRole("link", { name: zh.epic }));
  await screen.findByText("Dependent task");
  const card = container.querySelector('[data-card-id="CHILD"]') as HTMLElement;
  expect(within(card).getByText(zh.blocked)).toBeTruthy();
  expect(within(card).getByText(`${zh.dependencyPrefix}B`)).toBeTruthy();
  expect(within(card).queryByText(zh.assigned)).toBeNull();
  act(() => setLocale("en"));
  expect(within(card).queryByText(en.assigned)).toBeNull();
  expect(within(card).getByText(`${en.dependencyPrefix}B`)).toBeTruthy();
});

test("a mounted detail sheet translates immediately while preserving task content and loaded data", async () => {
  render(<Notices><TaskDetailSheet taskId={task.id} onSelectTask={() => {}} onOpenChange={() => {}} /></Notices>);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText(task.context!);
  expect(within(dialog).getByText(zh.context)).toBeTruthy();
  const requestsBefore = vi.mocked(fetchTask).mock.calls.length;

  act(() => setLocale("en"));
  expect(within(dialog).getByText(en.context)).toBeTruthy();
  expect(within(dialog).getByText(en.criteria)).toBeTruthy();
  expect(within(dialog).getByText(en.constraints)).toBeTruthy();
  expect(within(dialog).queryByText(zh.context)).toBeNull();
  expect(within(dialog).getByText(task.context!)).toBeTruthy();
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

test("a bookmarked ungrouped module keeps its legacy URL identity when the language changes", async () => {
  const user = userEvent.setup();
  const legacyEpic = "\u672a\u5206\u7ec4";
  history.replaceState(null, "", `/?view=modules&epic=${encodeURIComponent(legacyEpic)}`);
  vi.mocked(fetchModules).mockResolvedValue({ tasks: [
    { i: task.id, t: task.title, s: "open", e: "EXAMPLE" },
    { i: "DEMO-I18N-002", t: "Another named task", s: "open", e: "EXAMPLE" },
    { i: "DEMO-I18N-003", t: "Ungrouped example task", s: "open", e: "" },
  ], deps: [] });
  render(<Notices><App /></Notices>);
  await screen.findByRole("heading", { name: zh.ungrouped, level: 2 });
  expect(screen.getByText("Ungrouped example task")).toBeTruthy();
  expect(screen.queryByText(task.title)).toBeNull();
  expect(new URLSearchParams(location.search).get("epic")).toBe(legacyEpic);

  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  expect(screen.getByRole("heading", { name: en.ungrouped, level: 2 })).toBeTruthy();
  expect(screen.getByText("Ungrouped example task")).toBeTruthy();
  expect(screen.queryByText(task.title)).toBeNull();
  expect(new URLSearchParams(location.search).get("epic")).toBe(legacyEpic);
});

test("an active ungrouped board filter survives a language change", async () => {
  const user = userEvent.setup();
  vi.mocked(fetchBoard).mockResolvedValue({ ...board, columns: [{
    ...board.columns[0], tasks: [task, { ...task, id: "DEMO-I18N-003", title: "Ungrouped example task", epic: null }],
  }] });
  render(<Notices><App /></Notices>);
  await user.click(await screen.findByRole("button", { name: zh.boardFilter }));
  const filter = await screen.findByRole("combobox", { name: zh.filterEpic });
  await user.click(filter);
  await user.click(await screen.findByRole("option", { name: zh.ungrouped }));
  expect(screen.getByText("Ungrouped example task")).toBeTruthy();
  expect(screen.queryByText(task.title)).toBeNull();

  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  await user.click(screen.getByRole("button", { name: en.boardFilter }));
  expect(screen.getByRole("combobox", { name: en.filterEpic }).textContent).toContain(en.ungrouped);
  expect(screen.getByText("Ungrouped example task")).toBeTruthy();
  expect(screen.queryByText(task.title)).toBeNull();
});

test("sidebar toggles restore focus to the visible control in both directions", async () => {
  const user = userEvent.setup();
  render(<Notices><App /></Notices>);
  await screen.findByText(task.title);
  await user.click(screen.getByRole("button", { name: zh.toggleSidebar }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: zh.toggleSidebar }));
  expect(screen.queryByRole("navigation")).toBeNull();
  await user.keyboard("[[");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: zh.toggleSidebar }));
  expect(screen.getByRole("link", { name: zh.board })).toBeTruthy();
});
