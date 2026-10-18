import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { Notices } from "@/components/NawabanUI";
import { TaskDetailSheet } from "@/views/task-detail";
import { statusLabel, t } from "@/i18n";
import zh from "@/i18n/zh-CN.json";
import { fetchTask } from "@/lib/api";
import type { TaskDetail, TaskEvent } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  fetchTask: vi.fn(),
}));

const ev = (kind: TaskEvent["kind"], body: string, at: number, author = "worker-a"): TaskEvent =>
  ({ kind, body, author, at });
const decision = ev("decision", "问题:Which folder owns fetching\n结论:The view folder\n否决:Keep one file", 65, "user");
const links = [
  ev("link", "pr: https://example.test/pull/9", 64),
  ev("link", "merge_sha:abc1234 · merged after review", 63),
  ev("link", "docs/adr/0007.md", 62),
];
const task: TaskDetail = {
  id: "DEMO-DETAIL-001", title: "Split the detail drawer", status: "in_progress", project: "demo",
  session: "session-1", created_at: 1,
  body: "## What to build\nWhy the drawer is split\n\n## Acceptance criteria\n- Screens stay identical\n- No new dependency",
  parent: { id: "DEMO-SPEC", title: "Spec", status: "open" },
  children: [{ id: "DEMO-CHILD-001", title: "Child", status: "open" }],
  blocked_by: [{ id: "DEMO-BLOCK-001", title: "Upstream blocker", status: "in_progress" }],
  dependents: [{ id: "DEMO-NEXT-001", title: "Downstream task", status: "done" }],
  latest_note: ev("note", "Characterization in place", 70),
  decisions: [decision],
  links,
  // Newest first: the first five are visible, the sixth and seventh fold.
  events: [ev("note", "Characterization in place", 70), decision, ...links,
    ev("status", "open→in_progress", 20), ev("note", "Event body oldest", 10)],
};
const bare: TaskDetail = {
  ...task, id: "DEMO-DETAIL-002", title: "Bare task", status: "open", project: null, session: null,
  body: "", parent: null, children: [], blocked_by: [], dependents: [], latest_note: null,
  decisions: [], links: [], events: [],
};

beforeEach(() => {
  vi.mocked(fetchTask).mockReset().mockResolvedValue(task);
});

function sheet(taskId: string, handlers: { select?: (id: string) => void; close?: (open: boolean) => void; back?: () => void } = {}) {
  return <Notices>
    <TaskDetailSheet taskId={taskId} onSelectTask={handlers.select ?? (() => {})}
      onOpenChange={handlers.close ?? (() => {})} onBack={handlers.back} />
  </Notices>;
}
async function open(handlers: Parameters<typeof sheet>[1] = {}) {
  const view = render(sheet(task.id, handlers));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("heading", { name: task.title, level: 2 });
  return { ...view, dialog };
}
/** The block a section heading titles: its heading and everything beside it. */
function block(dialog: HTMLElement, label: string) {
  const heading = within(dialog).getByText(label, { selector: "h3" });
  return { heading, body: within(heading.parentElement!) };
}
const texts = (elements: Iterable<Element>) => [...elements].map((element) => element.textContent);

test("the reading column shows progress, body, criteria, blockers, dependents and decisions", async () => {
  const { dialog } = await open();
  const now = within(dialog).getByText(zh.currentProgress).parentElement!;
  expect(now.className).toContain("detail-now");
  expect(within(now).getByText("Characterization in place")).toBeTruthy();

  const context = block(dialog, zh.context).body;
  expect(context.getByText("Why the drawer is split")).toBeTruthy();
  expect(context.queryByText("Screens stay identical")).toBeNull();
  const criteria = block(dialog, zh.criteria);
  expect(texts(criteria.body.getAllByRole("listitem"))).toEqual(["Screens stay identical", "No new dependency"]);

  const blocked = block(dialog, zh.blockedBy);
  expect(blocked.heading.textContent).toBe(`${zh.blockedBy}1`);
  expect(texts(dialog.querySelectorAll(".divide-y")[0].children))
    .toEqual([`DEMO-BLOCK-001${statusLabel("in_progress")}Upstream blocker`]);
  const unblocks = block(dialog, zh.unblocks);
  expect(unblocks.heading.textContent).toBe(`${zh.unblocks}1`);
  expect(texts(dialog.querySelectorAll(".divide-y")[1].children))
    .toEqual([`DEMO-NEXT-001${statusLabel("done")}Downstream task`]);

  const decisions = block(dialog, zh.decisions);
  expect(decisions.heading.textContent).toBe(`${zh.decisions}1`);
  expect(decisions.body.getByText(/Which folder owns fetching/).textContent).toContain("否决:Keep one file");
  expect(decisions.body.getByText(/^user · /)).toBeTruthy();
  expect(decisions.heading.parentElement!.querySelectorAll(".detail-entry br")).toHaveLength(2);
});

test("links split kind, value and note; activity folds long lists and clamps long prose", async () => {
  const user = userEvent.setup();
  const { dialog } = await open();
  const refs = block(dialog, zh.reference);
  expect(refs.heading.textContent).toBe(`${zh.reference}3`);
  expect(texts(dialog.querySelectorAll(".detail-reference-kind"))).toEqual(["pr", "merge_sha"]);
  const pr = refs.body.getByRole("link", { name: "https://example.test/pull/9" });
  expect(pr.getAttribute("href")).toBe("https://example.test/pull/9");
  expect(pr.getAttribute("target")).toBe("_blank");
  expect(refs.body.getByText("merged after review").className).toContain("detail-reference-note");
  expect(texts(dialog.querySelectorAll(".detail-reference-value")))
    .toEqual(["https://example.test/pull/9", "abc1234", "docs/adr/0007.md"]);

  const activity = block(dialog, zh.activity);
  expect(activity.heading.textContent).toBe(`${zh.activity}7`);
  expect(activity.body.getAllByText("link")).toHaveLength(3);
  expect(activity.body.queryByText("Event body oldest")).toBeNull();
  const clamps = activity.body.getAllByRole("button", { name: zh.expandFullText });
  expect(clamps).toHaveLength(5);
  await user.click(clamps[0]);
  expect(clamps[0].getAttribute("aria-expanded")).toBe("true");
  await user.click(activity.body.getByRole("button", { name: t("moreItems", { count: 2 }) }));
  expect(activity.body.getByText("Event body oldest")).toBeTruthy();
  expect(activity.body.getByText("open→in_progress")).toBeTruthy();
});

test("the rail shows resume and the task's status, project, parent, children, session and time", async () => {
  const user = userEvent.setup();
  const { dialog } = await open();
  const resume = dialog.querySelector(".detail-resume") as HTMLElement;
  expect(within(resume).getByText(`session-1 · ${zh.inProgress}`)).toBeTruthy();
  const copy = within(resume).getByRole("button", { name: "resume" });
  await user.click(copy);
  expect(await navigator.clipboard.readText()).toBe("claude --resume session-1");

  const properties = block(dialog, zh.properties).heading.parentElement!;
  expect(texts(properties.querySelectorAll("p"))).toEqual(
    [zh.status, zh.project, zh.splitFrom, zh.splitOut, zh.session, zh.time]);
  const values = texts(properties.querySelectorAll(".detail-value"));
  expect(values.slice(0, 5)).toEqual([statusLabel("in_progress"), "demo", "DEMO-SPEC", "DEMO-CHILD-001", "session-1"]);
  expect(values[5]).toMatch(new RegExp(`^${zh.createdAt.replace("{time}", ".+")}$`));
});

test("task IDs, Back and close report to the owner of the drawer", async () => {
  const user = userEvent.setup();
  const select = vi.fn(), close = vi.fn(), back = vi.fn();
  const { dialog } = await open({ select, close, back });
  const header = dialog.querySelector(".detail-breadcrumb") as HTMLElement;
  expect(header.textContent).toBe(`${zh.back}demo / ${task.id}`);
  expect(within(header).getByRole("button", { name: t("copyText", { text: task.id }) })).toBeTruthy();

  for (const id of ["DEMO-BLOCK-001", "DEMO-NEXT-001", "DEMO-SPEC", "DEMO-CHILD-001"]) {
    await user.click(within(dialog).getByRole("button", { name: id }));
    expect(select).toHaveBeenLastCalledWith(id);
  }
  await user.click(within(header).getByRole("button", { name: zh.back }));
  expect(back).toHaveBeenCalledTimes(1);
  await user.click(within(dialog).getByRole("button", { name: zh.close }));
  expect(close).toHaveBeenCalledWith(false);
});

test("a closed task does not present its latest note as current progress", async () => {
  vi.mocked(fetchTask).mockResolvedValue({ ...task, status: "done", session: null });
  const { dialog } = await open();
  expect(dialog.querySelector(".detail-now")).toBeNull();
  expect(dialog.querySelector(".detail-resume")).toBeNull();
  expect(block(dialog, zh.activity).body.getAllByText("Characterization in place")).toHaveLength(1);
});

test("a task without optional data keeps only activity and the empty property values", async () => {
  vi.mocked(fetchTask).mockResolvedValue(bare);
  render(sheet(bare.id));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("heading", { name: bare.title, level: 2 });
  expect(texts(dialog.querySelectorAll("h3"))).toEqual([`${zh.activity}0`, zh.properties]);
  expect(dialog.querySelector(".detail-breadcrumb")!.textContent).toBe(`${zh.task} / ${bare.id}`);
  expect(within(dialog).queryByRole("button", { name: zh.back })).toBeNull();
  expect(dialog.querySelector(".detail-resume")).toBeNull();
  expect(dialog.querySelector(".detail-now")).toBeNull();
  expect(texts(dialog.querySelectorAll(".detail-value"))).toEqual([
    statusLabel("open"), zh.noProject, t("noValue", { label: zh.splitFrom }), zh.noOwner,
    expect.stringMatching(new RegExp(`^${zh.createdAt.replace("{time}", "[^·]+")}$`)),
  ]);
});

test("loading and failed reads show a state instead of the task", async () => {
  let fail!: (reason: Error) => void;
  vi.mocked(fetchTask).mockReturnValue(new Promise((_, reject) => { fail = reject; }));
  render(sheet(task.id));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(zh.loadingTasks)).toBeTruthy();
  await act(async () => fail(new Error("task read failed")));
  expect(within(dialog).getByText("Error: task read failed")).toBeTruthy();
  expect(within(dialog).queryByText(zh.loadingTasks)).toBeNull();
  expect(dialog.querySelector(".detail-grid")).toBeNull();
});

test("a late response for the previous task cannot replace the selected one", async () => {
  let late!: (value: TaskDetail) => void;
  vi.mocked(fetchTask).mockImplementation((id) =>
    id === task.id ? new Promise((resolve) => { late = resolve; }) : Promise.resolve(bare));
  const { rerender } = render(sheet(task.id));
  rerender(sheet(bare.id));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("heading", { name: bare.title, level: 2 });
  await act(async () => late(task));
  expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe(bare.title);
  expect(within(dialog).queryByText(task.title)).toBeNull();
  expect(fetchTask).toHaveBeenCalledTimes(2);
});
