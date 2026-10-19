import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import App from "@/App";
import { Notices } from "@/components/NawabanUI";
import { fetchBoard, fetchProjects } from "@/lib/api";
import zh from "@/i18n/zh-CN.json";
import en from "@/i18n/en.json";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  fetchBoard: vi.fn(), fetchProjects: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchProjects).mockResolvedValue({ projects: [
    { name: "demo", open: 1, total: 1 }, { name: "all", open: 1, total: 1 },
    { name: null, open: 1, total: 1 },
  ] });
  vi.mocked(fetchBoard).mockImplementation(async (_range, project) => ({
    columns: [{ key: "open", tasks: project === "" ? [{
      id: "EXAMPLE-001", title: "Legacy card without a project", status: "open", project: null,
      parent: null, session: null, created_at: 1, active_at: 1, open_blockers: 0,
    }] : [] }],
  }));
});

test("No project reveals legacy cards, persists, and translates", async () => {
  history.replaceState(null, "", "/?project=demo");
  const user = userEvent.setup();
  const view = render(<Notices><App /></Notices>);
  await user.click(await screen.findByRole("combobox", { name: zh.switchProject }));
  await user.click(await screen.findByRole("option", { name: zh.noProject }));
  await screen.findByText("Legacy card without a project");
  expect(new URLSearchParams(location.search).get("unassigned")).toBe("1");
  expect(localStorage.getItem("projectUnassigned")).toBe("1");
  await user.click(screen.getByRole("button", { name: zh.switchLanguage }));
  expect(screen.getByRole("combobox", { name: en.switchProject }).textContent).toContain(en.noProject);
  await waitFor(() => expect(fetchBoard).toHaveBeenLastCalledWith(null, ""));
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

test("a remembered project that no longer exists falls back to all projects", async () => {
  history.replaceState(null, "", "/?project=renamed-away");
  localStorage.setItem("project", "renamed-away");
  render(<Notices><App /></Notices>);
  await waitFor(() => expect(fetchBoard).toHaveBeenLastCalledWith(null, null));
  expect(screen.getByRole("combobox", { name: zh.switchProject }).textContent).toContain(zh.allProjects);
  expect(new URLSearchParams(location.search).get("project")).toBe("");
  expect(localStorage.getItem("project")).toBe("");
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
