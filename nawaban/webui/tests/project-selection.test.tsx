import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import App from "@/App";
import { Notices } from "@/components/NawabanUI";
import { fetchBoard, fetchInbox, fetchModules, fetchProjects } from "@/lib/api";
import zh from "@/i18n/zh-CN.json";
import en from "@/i18n/en.json";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  fetchBoard: vi.fn(), fetchInbox: vi.fn(), fetchModules: vi.fn(), fetchProjects: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProjects).mockResolvedValue({ projects: [
    { name: "demo", open: 1, total: 1 }, { name: "all", open: 1, total: 1 },
    { name: null, open: 1, total: 1 },
  ] });
  vi.mocked(fetchBoard).mockImplementation(async (_range, project) => ({
    columns: [{ key: "open", title: "Open", color: "gray", tasks: project === "" ? [{
      id: "EXAMPLE-001", title: "Legacy card without a project", status: "open", waiting_on: null,
      owner: null, epic: null, now: null, created_at: 1, started_at: null, completed_at: null,
      active_at: 1, fold: "EXAMPLE", project: null,
    }] : [] }],
    liveness: { available: false, complete: true, busy_window_s: 120, idle_window_s: 300 },
  }));
  vi.mocked(fetchModules).mockResolvedValue({ tasks: [], deps: [] });
  vi.mocked(fetchInbox).mockImplementation(async (project) => ({
    total: project === "" ? 1 : 0, oldest_days: 0, flow: { raised_7d: 0, closed_7d: 0 }, agent_side: 0,
    groups: project === "" ? [{ kind: "accept", title: "Acceptance", items: [{
      id: 1, kind: "accept", question: "Accept the legacy card?", evidence: "Test result",
      options: null, blast: null, hands_on: false, raised_at: 1, raised_by: "fixture",
      closed_at: null, closed_as: null, answer: null, decision_id: null,
      confidence: null, confidence_reason: null, stalled_days: 0, task_ids: ["EXAMPLE-001"],
    }] }] : [],
  }));
});

test("No project reveals legacy cards and asks, persists, and translates", async () => {
  history.replaceState(null, "", "/?project=demo");
  const user = userEvent.setup();
  const view = render(<Notices><App /></Notices>);
  await user.click(await screen.findByRole("combobox", { name: zh.switchProject }));
  await user.click(await screen.findByRole("option", { name: zh.noProject }));
  await screen.findByText("Legacy card without a project");
  expect(new URLSearchParams(location.search).get("unassigned")).toBe("1");
  expect(localStorage.getItem("projectUnassigned")).toBe("1");
  await user.click(screen.getByRole("link", { name: zh.inbox }));
  await screen.findAllByText("Accept the legacy card?");
  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  expect(screen.getByRole("combobox", { name: en.switchProject }).textContent).toContain(en.noProject);
  await user.click(screen.getByRole("link", { name: en.epic }));
  await waitFor(() => expect(fetchModules).toHaveBeenLastCalledWith(""));
  view.unmount();
  history.replaceState(null, "", "/");
  render(<Notices><App /></Notices>);
  await screen.findByText("Legacy card without a project");
});

test.each(["/?unassigned=1", "/?project=&unassigned=1"])("bookmark %s selects unassigned cards", async (url) => {
  history.replaceState(null, "", url);
  localStorage.setItem("project", "demo");
  render(<Notices><App /></Notices>);
  await screen.findByText("Legacy card without a project");
});

test("all projects and a project literally named all remain distinct", async () => {
  localStorage.setItem("projectUnassigned", "1");
  history.replaceState(null, "", "/?project=");
  const user = userEvent.setup();
  render(<Notices><App /></Notices>);
  await waitFor(() => expect(fetchBoard).toHaveBeenLastCalledWith(null, null));
  await user.click(screen.getByRole("combobox", { name: zh.switchProject }));
  await user.click(await screen.findByRole("option", { name: "all", exact: true }));
  await waitFor(() => expect(fetchBoard).toHaveBeenLastCalledWith(null, "all"));
  await user.click(screen.getByRole("combobox", { name: zh.switchProject }));
  await user.click(await screen.findByRole("option", { name: zh.allProjects }));
  await waitFor(() => expect(fetchBoard).toHaveBeenLastCalledWith(null, null));
  expect(localStorage.getItem("projectUnassigned")).toBe("0");
  expect(new URLSearchParams(location.search).has("unassigned")).toBe(false);
});
