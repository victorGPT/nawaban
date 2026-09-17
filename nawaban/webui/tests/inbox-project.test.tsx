import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { InboxView } from "@/components/InboxView";
import { Notices } from "@/components/NawabanUI";
import { fetchInbox, postAnswer } from "@/lib/api";
import type { AskItem, InboxResponse } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  fetchInbox: vi.fn(),
  postAnswer: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function inbox(...ids: number[]): InboxResponse {
  return {
    total: ids.length, oldest_days: 0, flow: { raised_7d: 0, closed_7d: 0 }, agent_side: 0,
    groups: [{ kind: "accept", title: "Acceptance", items: ids.map((id): AskItem => ({
      id, kind: "accept", question: `Ask ${id}`, evidence: "Ready for review",
      options: null, blast: null, hands_on: false, raised_at: 1, raised_by: "agent",
      closed_at: null, closed_as: null, answer: null, decision_id: null,
      confidence: null, confidence_reason: null, stalled_days: 0, task_ids: [],
    })) }],
  };
}
const view = (project: string) => <Notices><InboxView query="" project={project} onSelectTask={() => {}} /></Notices>;
beforeEach(() => vi.resetAllMocks());

test.each(["response", "error"])("an old project's late %s cannot replace the current inbox", async (outcome) => {
  const a = deferred<InboxResponse>(), b = deferred<InboxResponse>();
  vi.mocked(fetchInbox).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const { rerender } = render(view("A"));
  rerender(view("B"));
  await act(async () => b.resolve(inbox(2)));
  expect(screen.getAllByText("Ask 2").length).toBeGreaterThan(0);
  await act(async () => {
    if (outcome === "response") a.resolve(inbox(1));
    else a.reject(new Error("Obsolete project failed"));
  });
  expect(screen.queryByText(/Obsolete project failed/)).toBeNull();
  expect(screen.queryAllByText("Ask 1")).toHaveLength(0);
  expect(screen.getAllByText("Ask 2").length).toBeGreaterThan(0);
});

test("switching projects immediately removes the old answer controls and dialog", async () => {
  vi.mocked(fetchInbox).mockResolvedValueOnce(inbox(1)).mockReturnValueOnce(new Promise(() => {}));
  const { rerender } = render(view("A"));
  await screen.findByRole("button", { name: "\u6536\u4e0b" });
  fireEvent.click(screen.getByRole("button", { name: "\u6253\u56de" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  rerender(view("B"));
  expect(screen.queryByRole("button", { name: "\u6536\u4e0b" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryAllByText("Ask 1")).toHaveLength(0);
  expect(screen.getByText("\u6b63\u5728\u8bfb\u53d6\u6536\u4ef6\u7bb1…")).toBeTruthy();
});

test("an answer finishing after a project switch cannot refresh the old project", async () => {
  const answer = deferred<{ ok: boolean; out: string }>();
  vi.mocked(fetchInbox).mockResolvedValueOnce(inbox(1)).mockResolvedValueOnce(inbox(2));
  vi.mocked(postAnswer).mockReturnValueOnce(answer.promise);
  const { rerender } = render(view("A"));
  fireEvent.click(await screen.findByRole("button", { name: "\u6536\u4e0b" }));
  expect(postAnswer).toHaveBeenCalledWith(1, "\u9a8c\u6536\u901a\u8fc7(\u6536\u4ef6\u7bb1\u4e00\u952e)", false);
  rerender(view("B"));
  await screen.findAllByText("Ask 2");
  await act(async () => answer.resolve({ ok: true, out: "" }));
  expect(fetchInbox).toHaveBeenCalledTimes(2);
  expect(screen.queryAllByText("Ask 1")).toHaveLength(0);
});

test("overlapping answer refreshes only apply the newest response", async () => {
  const oldRefresh = deferred<InboxResponse>(), newRefresh = deferred<InboxResponse>();
  vi.mocked(fetchInbox).mockResolvedValueOnce(inbox(1, 2))
    .mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(newRefresh.promise);
  vi.mocked(postAnswer).mockResolvedValue({ ok: true, out: "" });
  render(view("A"));
  const firstAnswer = await screen.findByRole("button", { name: "\u6536\u4e0b" });
  await act(async () => fireEvent.click(firstAnswer));
  fireEvent.click(screen.getByRole("button", { name: /Ask 2/ }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "\u6536\u4e0b" })));
  expect(fetchInbox).toHaveBeenCalledTimes(3);
  await act(async () => newRefresh.resolve(inbox()));
  expect(screen.queryByRole("button", { name: "\u6536\u4e0b" })).toBeNull();
  await act(async () => oldRefresh.resolve(inbox(2)));
  expect(screen.queryByRole("button", { name: "\u6536\u4e0b" })).toBeNull();
  expect(screen.queryAllByText("Ask 2")).toHaveLength(0);
});
