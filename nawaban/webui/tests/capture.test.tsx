import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { CaptureView } from "@/views/capture";
import { CaptureError, fetchCaptures, postCapture, type Capture } from "@/lib/captures-api";
import { setLocale } from "@/i18n";
import en from "@/i18n/en.json";
import zh from "@/i18n/zh-CN.json";

vi.mock("@/lib/captures-api", async (original) => ({
  ...await original<typeof import("@/lib/captures-api")>(),
  fetchCaptures: vi.fn(), postCapture: vi.fn(),
}));
const item: Capture = {
  id: "0b1a22d1-7f13-4cf0-84bd-a3ce9c787abd", content: "Saved idea", project: "A",
  status: "pending", task_id: null, reason: null, created_at: 1, created_by: "human",
  resolved_at: null, resolved_by: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const view = (project: string, select = vi.fn()) =>
  <CaptureView key={project} project={project} query="" onSelectTask={select} />;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchCaptures).mockResolvedValue([]);
});

test("save immediately displays the idea while a prior poll is still pending", async () => {
  const poll = deferred<Capture[]>();
  vi.mocked(fetchCaptures).mockReturnValue(poll.promise);
  vi.mocked(postCapture).mockResolvedValue(item);
  render(view("A"));
  fireEvent.change(screen.getByRole("textbox", { name: zh.captureIdea }), { target: { value: item.content } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: zh.captureSave })));
  expect(screen.getByText(item.content)).toBeTruthy();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  await act(async () => poll.resolve([]));
  expect(screen.getByText(item.content)).toBeTruthy();
  const request = vi.mocked(postCapture).mock.calls[0][0];
  expect(request.project).toBe("A");
  expect(request.content).toBe(item.content);
});

test("uncertain save locks the material and retries the identical ID once", async () => {
  vi.mocked(postCapture).mockRejectedValueOnce(new CaptureError("", true)).mockResolvedValueOnce(item);
  render(view("A"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: item.content } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: zh.captureSave })));
  expect(screen.getByRole("alert").textContent).toBe(zh.captureUnknown);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  act(() => setLocale("en"));
  expect(screen.getByRole("alert").textContent).toBe(en.captureUnknown);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: en.captureRetry })));
  expect(postCapture).toHaveBeenCalledTimes(2);
  expect(vi.mocked(postCapture).mock.calls[0][0]).toEqual(vi.mocked(postCapture).mock.calls[1][0]);
  expect(screen.getAllByText(item.content)).toHaveLength(1);
});

test("history shows linked task and discard reason while pending list excludes them", async () => {
  const select = vi.fn();
  vi.mocked(fetchCaptures).mockResolvedValue([
    item,
    { ...item, id: "converted", content: "Converted idea", status: "converted", task_id: "FORMAL" },
    { ...item, id: "discarded", content: "Discarded idea", status: "discarded", reason: "Already covered" },
  ]);
  render(view("A", select));
  await screen.findByText(item.content);
  expect(screen.queryByText("Converted idea")).toBeNull();
  expect(screen.queryByText("Discarded idea")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: zh.captureShowHistory }));
  fireEvent.click(screen.getByRole("button", { name: "FORMAL" }));
  expect(select).toHaveBeenCalledWith("FORMAL");
  expect(screen.getByText("作废原因：Already covered")).toBeTruthy();
});

test("late reads and writes cannot move an idea into another project's view", async () => {
  const oldRead = deferred<Capture[]>(), write = deferred<Capture>();
  vi.mocked(fetchCaptures).mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce([]);
  vi.mocked(postCapture).mockReturnValue(write.promise);
  const { rerender } = render(view("A"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: item.content } });
  fireEvent.click(screen.getByRole("button", { name: zh.captureSave }));
  rerender(view("B"));
  await act(async () => { oldRead.resolve([item]); write.resolve(item); });
  expect(screen.queryByText(item.content)).toBeNull();
  expect(fetchCaptures).toHaveBeenCalledTimes(2);
  expect(vi.mocked(postCapture).mock.calls[0][0].project).toBe("A");
});


test("saving works on HTTP origins without crypto.randomUUID", async () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  vi.mocked(postCapture).mockResolvedValue(item);
  render(view("A"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: item.content } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: zh.captureSave })));
  expect(vi.mocked(postCapture).mock.calls[0][0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(screen.getByText(item.content)).toBeTruthy();
});


test("multiple saves stay newest first while a prior poll is pending", async () => {
  vi.mocked(fetchCaptures).mockReturnValue(new Promise(() => {}));
  vi.mocked(postCapture).mockResolvedValueOnce(item)
    .mockResolvedValueOnce({ ...item, id: "second", content: "Second idea" });
  render(view("A"));
  for (const content of [item.content, "Second idea"]) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: content } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: zh.captureSave })));
  }
  const first = screen.getByText("Second idea"), second = screen.getByText(item.content);
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
