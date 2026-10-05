import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { Notices } from "@/components/NawabanUI";
import { TaskDetailSheet } from "@/views/task-detail";
import { statusLabel, t } from "@/i18n";
import zh from "@/i18n/zh-CN.json";
import { fetchKin, fetchTask } from "@/lib/api";
import { WAIT } from "@/lib/nawaban-model";
import type { KinResponse, TaskDetail, TaskEvent, TaskRef } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  fetchKin: vi.fn(), fetchTask: vi.fn(),
}));

const event = (n: number, created_at: number): TaskEvent =>
  ({ kind: "note", body: `Event body ${n}`, author: n === 1 ? null : "worker-a", session_id: null, created_at });
const ref = (kind: string, value: string, note: string | null = null): TaskRef => ({ kind, value, note, created_at: 1 });
const task: TaskDetail = {
  id: "DEMO-DETAIL-001", title: "Split the detail drawer", status: "claimed", waiting_on: "decision",
  owner: "worker-a", epic: "DETAIL", now: "Characterization in place", created_at: 1,
  fold: "DETAIL", started_at: 2, completed_at: null, active_at: 2,
  captures: [{
    id: "capture-1", content: "Captured idea text", project: null, status: "converted", task_id: "DEMO-DETAIL-001",
    reason: null, created_at: 1, created_by: "human", resolved_at: 1, resolved_by: "worker-a",
  }],
  context: "Why the drawer is split", adr: "docs/adr/0007.md", success: ["Screens stay identical"],
  constraints: ["No new dependency"], touches: ["src/a.tsx, src/b.tsx"], edges_out: [], edges_in: [],
  decisions: [{
    id: 1, question: "Which folder owns fetching", verdict: "The view folder",
    rejected: ["Keep one file", { option: "Barrel index", reason: "unused" }],
    decided_by: "lead", adr: null, supersedes: null, created_at: 1,
  }],
  // Newest first: session end, letter, events 1-3 are visible; event 4 and the session start are folded.
  events: [event(1, 70), event(2, 60), event(3, 50), event(4, 40)],
  letters: [{ id: 1, kind: "nudge", msg: "Letter message text", links: null, session_id: null, created_at: 80, read_at: null }],
  sessions: [{
    owner: "worker-a", session_id: "session-1", started_at: 10, ended_at: 90,
    outcome: "handoff", summary: "Session summary text", note: "Session note text",
  }],
  refs: [
    ref("acceptance_run", "https://example.test/run/1"), ref("acceptance_run", "Acceptance run two", "Run note"),
    ref("acceptance_run", "Acceptance run three"),
    ref("pr", "https://example.test/pr/9"), ref("sha", "abc1234", "Ref note"), ref("doc", "docs/x.md"),
    ref("branch", "task/x"), ref("issue", "issue-5"), ref("tag", "v1"),
  ],
};
const kin: KinResponse = {
  blocked_by: [
    { id: "DEMO-BLOCK-001", title: "Upstream blocker", status: "open", depth: 1 },
    { id: "DEMO-BLOCK-002", title: "Root blocker", status: "claimed", depth: 2 },
  ],
  stuck_at: "DEMO-BLOCK-002",
  unblocks: [{ id: "DEMO-NEXT-001", title: "Downstream task", status: "done", others_waiting: 2 }],
  epic: "DETAIL",
  lineage: {
    split_from: "DEMO-PARENT-001", split_out: ["DEMO-CHILD-001", "DEMO-CHILD-002"],
    supersedes: ["DEMO-OLD-001"], superseded_by: ["DEMO-NEW-001"], latest_decision: null,
  },
};
const bare: TaskDetail = {
  ...task, id: "DEMO-DETAIL-002", title: "Bare task", waiting_on: null, owner: null, epic: null, now: null,
  started_at: null, captures: [], context: null, adr: null, success: null, constraints: null, touches: null,
  decisions: [], events: [], letters: [], sessions: [], refs: [],
};
const noKin: KinResponse = {
  blocked_by: [], stuck_at: null, unblocks: [], epic: null,
  lineage: { split_from: null, split_out: [], supersedes: [], superseded_by: [], latest_decision: null },
};

beforeEach(() => {
  vi.mocked(fetchTask).mockReset().mockResolvedValue(task);
  vi.mocked(fetchKin).mockReset().mockResolvedValue(kin);
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

test("the reading column shows progress, capture source, context, criteria, blockers and decisions", async () => {
  const { dialog } = await open();
  const now = within(dialog).getByText(zh.currentProgress).parentElement!;
  expect(now.className).toContain("detail-now");
  expect(within(now).getByText(task.now!)).toBeTruthy();

  const capture = block(dialog, zh.captureOrigin).body;
  expect(capture.getByText("capture-1").tagName).toBe("CODE");
  expect(capture.getByText("Captured idea text")).toBeTruthy();
  expect(block(dialog, zh.context).body.getByText(task.context!)).toBeTruthy();

  const criteria = block(dialog, zh.criteria), constraints = block(dialog, zh.constraints);
  expect(criteria.heading.textContent).toBe(`${zh.criteria}1`);
  expect(texts(criteria.body.getAllByRole("listitem"))).toEqual(["Screens stay identical"]);
  expect(constraints.heading.textContent).toBe(`${zh.constraints}1`);
  expect(texts(constraints.body.getAllByRole("listitem"))).toEqual(["No new dependency"]);
  expect(criteria.heading.closest("section")).toBe(constraints.heading.closest("section"));
  expect(criteria.heading.closest("section")!.className).toBe("detail-criteria");

  const blocked = block(dialog, zh.blockedBy);
  expect(blocked.heading.textContent).toBe(`${zh.blockedBy}2`);
  expect(blocked.body.getByText(zh.stuckAt.trim()).textContent).toBe(`${zh.stuckAt}DEMO-BLOCK-002`);
  const rows = dialog.querySelectorAll(".divide-y")[0].children;
  expect(texts(rows)).toEqual(["DEMO-BLOCK-001openUpstream blocker", "DEMO-BLOCK-002claimedRoot blocker"]);
  expect([...rows].map((row) => (row as HTMLElement).style.marginLeft)).toEqual(["0px", "12px"]);

  const unblocks = block(dialog, zh.unblocks);
  expect(unblocks.heading.textContent).toBe(`${zh.unblocks}1`);
  expect(texts(dialog.querySelectorAll(".divide-y")[1].children))
    .toEqual([`DEMO-NEXT-001doneDownstream task${t("othersWaiting", { count: 2 })}`]);

  const decisions = block(dialog, zh.decisions);
  expect(decisions.heading.textContent).toBe(`${zh.decisions}1`);
  expect(decisions.body.getByText("Which folder owns fetching").closest(".detail-subheading")).toBeTruthy();
  expect(decisions.body.getByText("The view folder")).toBeTruthy();
  expect(texts(decisions.body.getAllByRole("listitem")))
    .toEqual([`${zh.rejected}Keep one file`, `${zh.rejected}Barrel index —— unused`]);
  expect(decisions.body.getByText(/^lead · /)).toBeTruthy();
});

test("evidence and activity fold long lists and clamp long prose until expanded", async () => {
  const user = userEvent.setup();
  const { dialog } = await open();
  const evidence = block(dialog, zh.evidence);
  expect(evidence.heading.textContent).toBe(`${zh.evidence}3`);
  const run = evidence.body.getByRole("link", { name: "https://example.test/run/1" });
  expect(run.getAttribute("href")).toBe("https://example.test/run/1");
  expect(run.getAttribute("target")).toBe("_blank");
  expect(evidence.body.getByText("Acceptance run two")).toBeTruthy();
  expect(evidence.body.getByText("Run note")).toBeTruthy();
  expect(evidence.body.queryByText("Acceptance run three")).toBeNull();
  await user.click(evidence.body.getByRole("button", { name: t("moreItems", { count: 1 }) }));
  expect(evidence.body.getByText("Acceptance run three")).toBeTruthy();
  await user.click(evidence.body.getByRole("button", { name: zh.collapse }));
  expect(evidence.body.queryByText("Acceptance run three")).toBeNull();

  const activity = block(dialog, zh.activity);
  expect(activity.heading.textContent).toBe(`${zh.activity}7`);
  expect(activity.body.getByText(new RegExp(`^${t("wrapupOutcome", { outcome: "handoff" })} · `))).toBeTruthy();
  expect(activity.body.getByText("Session summary text")).toBeTruthy();
  expect(activity.body.getByText("Session note text")).toBeTruthy();
  expect(activity.body.getByText(zh.notifications)).toBeTruthy();
  expect(activity.body.getByText("nudge")).toBeTruthy();
  expect(activity.body.getByText(zh.unread).className).toContain("text-status-yellow-text");
  expect(activity.body.getByText("Letter message text")).toBeTruthy();
  expect(activity.body.getByText("?")).toBeTruthy();
  expect(activity.body.getAllByText("note")).toHaveLength(3);
  expect(activity.body.getByText("Event body 3")).toBeTruthy();
  expect(activity.body.queryByText("Event body 4")).toBeNull();

  const clamps = activity.body.getAllByRole("button", { name: zh.expandFullText });
  expect(clamps).toHaveLength(5);
  expect(dialog.querySelectorAll(".line-clamp-3")).toHaveLength(5);
  await user.click(clamps[0]);
  expect(clamps[0].textContent).toBe(zh.collapse);
  expect(clamps[0].getAttribute("aria-expanded")).toBe("true");
  expect(dialog.querySelectorAll(".line-clamp-3")).toHaveLength(4);

  await user.click(activity.body.getByRole("button", { name: t("moreItems", { count: 2 }) }));
  expect(activity.body.getByText("Event body 4")).toBeTruthy();
  expect(activity.body.getByText(new RegExp(`^${zh.start} · `))).toBeTruthy();
  expect(activity.body.getAllByRole("button", { name: zh.expandFullText })).toHaveLength(5);
});

test("the rail shows resume, six properties, relationships, scope and references", async () => {
  const user = userEvent.setup();
  const { dialog } = await open();
  const resume = dialog.querySelector(".detail-resume") as HTMLElement;
  expect(within(resume).getByText("worker-a · handoff")).toBeTruthy();
  const copy = within(resume).getByRole("button", { name: "resume" });
  expect(copy.title).toBe(t("copyText", { text: "claude --resume session-1" }));
  await user.click(copy);
  expect(await navigator.clipboard.readText()).toBe("claude --resume session-1");

  const properties = block(dialog, zh.properties).heading.parentElement!;
  expect(properties.className).toContain("detail-attribute-group");
  expect(texts(properties.querySelectorAll("p"))).toEqual(
    [zh.stageLabel, zh.waitingOn, zh.owner, zh.epic, zh.decisionDocument, zh.time]);
  const values = texts(properties.querySelectorAll(".detail-value"));
  expect(values.slice(0, 5)).toEqual([statusLabel("claimed"), WAIT.decision, "worker-a", "DETAIL", "docs/adr/0007.md"]);
  expect(values[5]).toMatch(new RegExp(`^${zh.createdAt.replace("{time}", ".+")} · ${zh.startedAt.replace("{time}", ".+")}$`));
  expect([...properties.querySelectorAll(".detail-mono")].map((value) => value.textContent)).toEqual(["worker-a", "docs/adr/0007.md"]);

  const relations = block(dialog, zh.relationships).heading.parentElement!;
  expect(relations.className).toContain("detail-long-attributes");
  expect(texts(relations.querySelectorAll("p"))).toEqual(
    [zh.splitFrom, zh.splitOut, zh.supersedes, zh.supersededBy, zh.scope, zh.reference]);
  expect(texts(within(relations).getAllByRole("button").slice(0, 5)))
    .toEqual(["DEMO-PARENT-001", "DEMO-CHILD-001", "DEMO-CHILD-002", "DEMO-OLD-001", "DEMO-NEW-001"]);
  expect(texts(relations.querySelectorAll(".detail-file-list code"))).toEqual(["src/a.tsx", "src/b.tsx"]);
  expect(texts(relations.querySelectorAll(".detail-reference-kind"))).toEqual(["pr", "sha", "doc"]);
  expect(within(relations).getByRole("link").getAttribute("href")).toBe("https://example.test/pr/9");
  expect(within(relations).getByText("Ref note").className).toContain("detail-reference-note");
  await user.click(within(relations).getByRole("button", { name: t("moreItems", { count: 3 }) }));
  expect(texts(relations.querySelectorAll(".detail-reference-value")))
    .toEqual(["https://example.test/pr/9", "abc1234", "docs/x.md", "task/x", "issue-5", "v1"]);
});

test("task IDs, Back and close report to the owner of the drawer", async () => {
  const user = userEvent.setup();
  const select = vi.fn(), close = vi.fn(), back = vi.fn();
  const { dialog } = await open({ select, close, back });
  const header = dialog.querySelector(".detail-breadcrumb") as HTMLElement;
  expect(header.textContent).toBe(`${zh.back}DETAIL / ${task.id}`);
  expect(within(header).getByRole("button", { name: t("copyText", { text: task.id }) })).toBeTruthy();

  for (const id of ["DEMO-BLOCK-002", "DEMO-BLOCK-001", "DEMO-NEXT-001", "DEMO-PARENT-001", "DEMO-CHILD-002", "DEMO-OLD-001", "DEMO-NEW-001"]) {
    await user.click(within(dialog).getAllByRole("button", { name: id })[0]);
    expect(select).toHaveBeenLastCalledWith(id);
  }
  expect(select).toHaveBeenCalledTimes(7);
  await user.click(within(header).getByRole("button", { name: zh.back }));
  expect(back).toHaveBeenCalledTimes(1);
  await user.click(within(dialog).getByRole("button", { name: zh.close }));
  expect(close).toHaveBeenCalledWith(false);
});

test("a task without optional data keeps only activity and the empty property values", async () => {
  vi.mocked(fetchTask).mockResolvedValue(bare);
  vi.mocked(fetchKin).mockResolvedValue(noKin);
  render(sheet(bare.id));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("heading", { name: bare.title, level: 2 });
  expect(texts(dialog.querySelectorAll("h3"))).toEqual([`${zh.activity}0`, zh.properties, zh.relationships]);
  expect(dialog.querySelector(".detail-breadcrumb")!.textContent).toBe(`${zh.task} / ${bare.id}`);
  expect(within(dialog).queryByRole("button", { name: zh.back })).toBeNull();
  expect(dialog.querySelector(".detail-resume")).toBeNull();
  expect(dialog.querySelector(".detail-now")).toBeNull();
  const empty = (label: string) => t("noValue", { label });
  expect(texts(dialog.querySelectorAll(".detail-value"))).toEqual([
    statusLabel("claimed"), zh.notWaiting, zh.noOwner, empty(zh.epic), empty(zh.decisionDocument),
    expect.stringMatching(new RegExp(`^${zh.createdAt.replace("{time}", "[^·]+")}$`)), empty(zh.scope), empty(zh.reference),
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
  expect(fetchKin).toHaveBeenCalledTimes(2);
});
