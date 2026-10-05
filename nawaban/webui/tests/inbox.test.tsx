import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { InboxView } from "@/views/inbox";
import { Notices } from "@/components/NawabanUI";
import { t } from "@/i18n";
import zh from "@/i18n/zh-CN.json";
import type { Project } from "@/lib/api";
import type { AskItem, InboxResponse } from "@/lib/types";

const ask = (id: number, kind: AskItem["kind"], overrides: Partial<AskItem> = {}): AskItem => ({
  id, kind, question: `Question ${id}`, evidence: "", options: null, blast: null, hands_on: false,
  raised_at: 1, raised_by: "agent", closed_at: null, closed_as: null, answer: null, decision_id: null,
  confidence: null, confidence_reason: null, stalled_days: 0, task_ids: [], ...overrides,
});
const accept = ask(11, "accept", {
  evidence: "Evidence for eleven", hands_on: true, stalled_days: 3, confidence: 0.824,
  confidence_reason: "tests are green", blast: { scope: "webui", risk: "low" },
  task_ids: ["DEMO-INBOX-001", "DEMO-INBOX-002"],
});
const decide = ask(12, "decide", {
  options: [{ option: "Option A", consequence: "Consequence A" }, { option: "Option B" }],
});
const openDecide = ask(13, "decide");
const authorize = ask(14, "authorize", { options: [{ option: "Plain option", consequence: "Plain consequence" }] });
const full: InboxResponse = {
  total: 4, oldest_days: 3, flow: { raised_7d: 5, closed_7d: 2 }, agent_side: 0,
  groups: [
    { kind: "accept", title: "Accept title", items: [accept] },
    { kind: "decide", title: "Decide title", items: [decide, openDecide] },
    { kind: "authorize", title: "Authorize title", items: [authorize] },
    { kind: "custom", title: "Custom title", items: [] },
  ],
};
const only = (...items: AskItem[]): InboxResponse =>
  ({ ...full, total: items.length, groups: [{ kind: items[0]?.kind ?? "accept", title: "Group", items }] });
const empty: InboxResponse = { ...full, total: 0, oldest_days: 0, groups: [] };

type Reply = { status?: number; body: unknown } | Error | "pending";
// Each queue's last reply repeats, so a refresh sees the same inbox unless a test queues another.
let inboxes: Reply[], answers: Reply[];
const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
  const queue = url === "/api/answer" ? answers : inboxes;
  const reply = queue.length > 1 ? queue.shift()! : queue[0];
  if (reply === "pending") return new Promise<never>(() => {});
  if (reply instanceof Error) return Promise.reject(reply);
  const status = reply.status ?? 200;
  return Promise.resolve({ ok: status < 400, status, json: async () => reply.body });
});
const urls = () => fetchMock.mock.calls.map(([url]) => url);
const posts = () => fetchMock.mock.calls.filter(([url]) => url === "/api/answer")
  .map(([, init]) => ({ method: init!.method, headers: init!.headers, body: JSON.parse(init!.body as string) }));
const post = (ask_id: number, verdict: string, reject: boolean) =>
  ({ method: "POST", headers: { "Content-Type": "application/json" }, body: { ask_id, verdict, reject } });

beforeEach(() => {
  inboxes = [{ body: full }];
  answers = [{ body: { ok: true, out: "" } }];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

function view(props: { project?: Project; query?: string; select?: (id: string) => void } = {}) {
  return <Notices>
    <InboxView query={props.query ?? ""} project={props.project === undefined ? "demo" : props.project}
      onSelectTask={props.select ?? (() => {})} />
  </Notices>;
}
async function open(replies: Reply[] = inboxes, props: Parameters<typeof view>[0] = {}) {
  inboxes = replies;
  const rendered = render(view(props));
  await waitFor(() => expect(rendered.container.querySelector(".inbox-layout")).toBeTruthy());
  /** The one ask card that is not hidden. */
  const card = () => rendered.container.querySelector(".inbox-reading > div:not([hidden]) .ask-card") as HTMLElement;
  return { ...rendered, card, user: userEvent.setup() };
}
const texts = (elements: Iterable<Element>) => [...elements].map((element) => element.textContent);
/** The answer dialog; a notice is a dialog by role too. */
const modal = () => document.querySelector(".nawaban-modal");
const disabled = (name: string) => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

test("the index summarises the inbox, groups asks by kind and shows the selected ask alone", async () => {
  const { container, card, user } = await open();
  expect(urls()).toEqual(["/api/inbox?project=demo"]);
  const index = container.querySelector(".inbox-index") as HTMLElement;
  expect(index.firstElementChild!.textContent).toBe(
    t("inboxPending", { count: 4, days: 3 }) + t("inboxFlow", { raised: 5, closed: 2 }));
  expect(texts(index.querySelectorAll("h2"))).toEqual([`${zh.acceptance} 1`, `${zh.decision} 2`, `${zh.approval} 1`]);
  expect(texts(index.querySelectorAll(".inbox-item"))).toEqual([
    `${zh.acceptance}#11${zh.handsOn}${t("daysCount", { days: 3 })}Question 11`,
    `${zh.decision}#12${t("daysCount", { days: 0 })}Question 12`,
    `${zh.decision}#13${t("daysCount", { days: 0 })}Question 13`,
    `${zh.approval}#14${t("daysCount", { days: 0 })}Question 14`,
  ]);
  const current = () => texts(index.querySelectorAll('.inbox-item[aria-current="true"] p'));
  expect(current()).toEqual(["Question 11"]);
  expect(container.querySelectorAll(".ask-card")).toHaveLength(4);
  expect(within(card()).getByText("#11")).toBeTruthy();

  await user.click(within(index).getByRole("button", { name: /Question 13/ }));
  expect(current()).toEqual(["Question 13"]);
  expect(within(card()).getByText("#13")).toBeTruthy();
  expect(container.querySelectorAll(".inbox-reading > div[hidden]")).toHaveLength(3);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("an ask card shows its kind, wait, blast radius, evidence, confidence and task links", async () => {
  const select = vi.fn();
  const { card, user } = await open(inboxes, { select });
  const header = card().querySelector("header")!;
  expect(header.firstElementChild!.textContent)
    .toBe(`${zh.acceptance}#11${zh.handsOn}${t("waitingDays", { days: 3 })}`);
  expect(within(header).getByText("Question 11").closest(".detail-subheading")).toBeTruthy();
  expect(texts(card().querySelectorAll("dt"))).toEqual(["scope", "risk"]);
  expect(texts(card().querySelectorAll("dd"))).toEqual(["webui", "low"]);
  expect(within(card()).getByText("Evidence for eleven").className).toContain("whitespace-pre-wrap");
  expect(within(card()).getByText(t("confidence", { percent: 82 })).parentElement!.textContent)
    .toBe(`${t("confidence", { percent: 82 })} · tests are green`);
  expect(texts(card().querySelectorAll("footer button"))).toEqual([zh.requestChanges, zh.acknowledge]);
  expect(within(card()).queryByRole("radiogroup")).toBeNull();
  expect(within(card()).queryByText(zh.authorizeExecutionNotice)).toBeNull();

  expect(texts(card().querySelectorAll(".detail-code-link"))).toEqual(["DEMO-INBOX-001", "DEMO-INBOX-002"]);
  await user.click(within(card()).getByRole("button", { name: "DEMO-INBOX-002" }));
  expect(select).toHaveBeenCalledExactlyOnceWith("DEMO-INBOX-002");
});

test("acknowledging posts the one-click verdict, announces the result and reloads the inbox", async () => {
  answers = [{ body: { ok: true, out: "decision 7 recorded" } }];
  const { container, card, user } = await open([{ body: full }, { body: only(decide) }]);
  await user.click(screen.getByRole("button", { name: zh.acknowledge }));
  expect(posts()).toEqual([post(11, zh.acceptVerdict, false)]);
  expect(await screen.findByText(t("resolvedAsk", { id: 11 }))).toBeTruthy();
  expect(screen.getByText("decision 7 recorded")).toBeTruthy();
  await waitFor(() => expect(within(card()).getByText("#12")).toBeTruthy());
  expect(urls()).toEqual(["/api/inbox?project=demo", "/api/answer", "/api/inbox?project=demo"]);
  expect(container.querySelectorAll(".ask-card")).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("requesting changes takes a reason in a dialog and posts it as a rejection", async () => {
  const { user } = await open([{ body: only(accept) }]);
  await user.click(screen.getByRole("button", { name: zh.requestChanges }));
  const dialog = screen.getByRole("dialog", { name: `${zh.requestChanges} #11` });
  const reason = within(dialog).getByRole("textbox", { name: zh.rejectReason }) as HTMLTextAreaElement;
  expect(reason.placeholder).toBe(zh.rejectReason + zh.recordedVerbatim);
  expect(disabled(zh.submit)).toBe(true);
  await user.type(reason, "   ");
  expect(disabled(zh.submit)).toBe(true);

  await user.click(within(dialog).getByRole("button", { name: zh.cancel }));
  await waitFor(() => expect(modal()).toBeNull());
  expect(posts()).toEqual([]);

  await user.click(screen.getByRole("button", { name: zh.requestChanges }));
  await user.type(screen.getByRole("textbox", { name: zh.rejectReason }), " needs a test ");
  await user.click(screen.getByRole("button", { name: zh.submit }));
  expect(posts()).toEqual([post(11, "needs a test", true)]);
  await waitFor(() => expect(modal()).toBeNull());
  expect(await screen.findByText(t("resolvedAsk", { id: 11 }))).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("a decision with options is answered on the card by option, option plus supplement, or free text", async () => {
  const { card, user } = await open([{ body: only(decide) }]);
  const confirm = () => within(card()).getByRole("button", { name: zh.confirmDecision }) as HTMLButtonElement;
  const radios = () => within(card()).getAllByRole("radio");
  expect(within(card()).getByRole("radiogroup", { name: zh.decisionOptions }).className).toContain("decision-options");
  expect(texts(card().querySelectorAll(".decision-options label")))
    .toEqual(["Option AConsequence A", "Option B", zh.other]);
  expect(confirm().disabled).toBe(true);
  expect(confirm().title).toBe(zh.selectOption);
  expect(within(card()).queryByRole("textbox")).toBeNull();

  await user.click(radios()[1]);
  expect(confirm().disabled).toBe(false);
  expect(confirm().title).toBe("");
  const supplement = within(card()).getByRole("textbox", { name: zh.supplementDetails }) as HTMLTextAreaElement;
  expect(supplement.placeholder).toBe(zh.supplement);
  await user.click(confirm());
  expect(posts()).toEqual([post(12, "Option B", false)]);
  // A recorded decision clears the selection and its drafts.
  await waitFor(() => expect(confirm().disabled).toBe(true));
  expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
  expect(within(card()).queryByRole("textbox")).toBeNull();

  await user.click(radios()[0]);
  await user.type(within(card()).getByRole("textbox", { name: zh.supplementDetails }), " after the release ");
  await user.click(confirm());
  expect(posts()[1]).toEqual(post(12, `Option A${zh.supplementMarker}after the release`, false));
  await waitFor(() => expect(confirm().disabled).toBe(true));

  await user.click(radios()[2]);
  const other = within(card()).getByRole("textbox", { name: zh.otherDecision }) as HTMLTextAreaElement;
  expect(other.placeholder).toBe(zh.answerPlaceholder);
  expect(within(card()).queryByRole("textbox", { name: zh.supplementDetails })).toBeNull();
  expect(confirm().disabled).toBe(true);
  expect(confirm().title).toBe("");
  await user.type(other, " a third way ");
  await user.click(confirm());
  expect(posts()[2]).toEqual(post(12, "a third way", false));
  expect(modal()).toBeNull();
});

test("authorizations and decisions without options answer in a dialog; their options are read-only", async () => {
  const { card, user } = await open([{ body: only(authorize, openDecide) }]);
  expect(within(card()).getByText(zh.authorizeExecutionNotice)).toBeTruthy();
  expect(within(card()).queryByRole("radio")).toBeNull();
  expect(texts(card().querySelectorAll(".decision-options .inbox-option"))).toEqual(["Plain optionPlain consequence"]);
  expect(texts(card().querySelectorAll("footer button"))).toEqual([zh.approve]);

  await user.click(within(card()).getByRole("button", { name: zh.approve }));
  const dialog = screen.getByRole("dialog", { name: `${zh.approve} #14` });
  const answer = within(dialog).getByRole("textbox", { name: zh.answer }) as HTMLTextAreaElement;
  expect(answer.placeholder).toBe(zh.answer + zh.recordedVerbatim);
  expect(disabled(zh.submit)).toBe(true);
  await user.type(answer, "go ahead");
  await user.click(within(dialog).getByRole("button", { name: zh.submit }));
  expect(posts()).toEqual([post(14, "go ahead", false)]);
  await waitFor(() => expect(modal()).toBeNull());

  await user.click(screen.getByRole("button", { name: /Question 13/ }));
  expect(card().querySelector(".decision-options")).toBeNull();
  expect(within(card()).queryByText(zh.authorizeExecutionNotice)).toBeNull();
  await user.click(within(card()).getByRole("button", { name: zh.confirmDecision }));
  await user.type(within(screen.getByRole("dialog", { name: `${zh.confirmDecision} #13` }))
    .getByRole("textbox", { name: zh.answer }), "ship it");
  await user.click(screen.getByRole("button", { name: zh.submit }));
  expect(posts()[1]).toEqual(post(13, "ship it", false));
});

test("a refused answer shows the server message on the card and in the dialog and keeps the draft", async () => {
  answers = [{ status: 409, body: { ok: false, out: "Ask already closed" } }, { status: 500, body: { ok: false, out: "" } }];
  const { user } = await open([{ body: only(accept) }]);
  await user.click(screen.getByRole("button", { name: zh.requestChanges }));
  await user.type(screen.getByRole("textbox", { name: zh.rejectReason }), "not yet");
  await user.click(screen.getByRole("button", { name: zh.submit }));
  expect(await screen.findAllByText("Error: Ask already closed")).toHaveLength(2);
  expect(modal()).toBeTruthy();
  expect((screen.getByRole("textbox", { name: zh.rejectReason }) as HTMLTextAreaElement).value).toBe("not yet");
  expect(disabled(zh.submit)).toBe(false);
  expect(screen.queryByText(t("resolvedAsk", { id: 11 }))).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await user.click(screen.getByRole("button", { name: zh.submit }));
  expect(await screen.findAllByText("Error: HTTP 500")).toHaveLength(2);
  expect(screen.queryByText("Error: Ask already closed")).toBeNull();
  expect(screen.queryByRole("button", { name: zh.verifyAnswerResult })).toBeNull();
});

test("an answer whose outcome is unknown locks the card until the inbox is re-read", async () => {
  answers = [new TypeError("network down")];
  const { card, user } = await open([{ body: only(accept) }, { body: empty }]);
  await user.click(screen.getByRole("button", { name: zh.acknowledge }));
  expect((await within(card()).findByRole("alert")).textContent).toBe(zh.unknownAnswer);
  expect(disabled(zh.acknowledge)).toBe(true);
  expect(disabled(zh.requestChanges)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await user.click(screen.getByRole("button", { name: zh.verifyAnswerResult }));
  expect(await screen.findByText(zh.inboxEmpty)).toBeTruthy();
  expect(urls()).toEqual(["/api/inbox?project=demo", "/api/answer", "/api/inbox?project=demo"]);
});

test("the self-approved digest opens to its checkable rows and copies a reopen command", async () => {
  const done = Math.floor(Date.now() / 1000) - 7200;
  const row = (id: string, self_evident: boolean, evidence: string | null) =>
    ({ id, title: `Title ${id}`, completed_at: done, evidence, self_evident });
  const { container, user } = await open([{ body: { ...empty, self_approved: [
    row("DEMO-AUTO-001", true, "e".repeat(200)), row("DEMO-AUTO-002", true, null), row("DEMO-AUTO-003", false, "silent"),
  ] } }]);
  const summary = container.querySelector(".inbox-summary") as HTMLElement;
  const toggle = within(summary).getByRole("button");
  expect(toggle.textContent).toBe(t("selfApprovedTitle", { count: 3 })
    + t("selfApprovedCounts", { count: 2, other: t("otherTaskCount", { count: 1 }) }));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(summary.querySelector(".inbox-history-row")).toBeNull();

  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const rows = summary.querySelectorAll(".inbox-history-row");
  expect(texts(rows[0].querySelectorAll("span, p, code"))).toEqual([
    "DEMO-AUTO-001", t("elapsedAgo", { time: "2h" }), "Title DEMO-AUTO-001", "e".repeat(160),
    'nawaban reopen DEMO-AUTO-001 --reason "..."',
  ]);
  expect(texts(rows[1].querySelectorAll("span, p, code"))).toEqual([
    "DEMO-AUTO-002", t("elapsedAgo", { time: "2h" }), "Title DEMO-AUTO-002",
    'nawaban reopen DEMO-AUTO-002 --reason "..."',
  ]);
  expect(rows).toHaveLength(2);
  expect(within(summary).getByText(t("selfApprovedRemainder", { count: 1 }))).toBeTruthy();

  await user.click(within(rows[1] as HTMLElement).getByRole("button", { name: zh.copyCommand }));
  expect(await navigator.clipboard.readText()).toBe('nawaban reopen DEMO-AUTO-002 --reason "..."');
  expect(await screen.findByText(zh.copied)).toBeTruthy();
  await user.click(toggle);
  expect(summary.querySelector(".inbox-history-row")).toBeNull();
});

test("an inbox without self-approved work or with only checkable rows omits the digest parts", async () => {
  const first = await open([{ body: { ...empty, self_approved: [] } }]);
  expect(first.container.querySelector(".inbox-summary")).toBeNull();
  first.unmount();
  const { container, user } = await open([{ body: { ...empty, self_approved: [
    { id: "DEMO-AUTO-001", title: "Only row", completed_at: null, evidence: null, self_evident: true },
  ] } }]);
  const toggle = within(container.querySelector(".inbox-summary") as HTMLElement).getByRole("button");
  expect(toggle.textContent).toBe(t("selfApprovedTitle", { count: 1 }) + t("selfApprovedCounts", { count: 1, other: "" }));
  await user.click(toggle);
  expect(container.querySelectorAll(".inbox-summary p")).toHaveLength(1);
});

test("loading, unavailable and failed reads show a state instead of the inbox", async () => {
  inboxes = ["pending"];
  const loading = render(view());
  expect(loading.getByText(zh.loadingInbox)).toBeTruthy();
  expect(loading.getByText(zh.workspace)).toBeTruthy();
  expect(loading.container.querySelector(".inbox-layout")).toBeNull();
  loading.unmount();

  inboxes = [{ body: { ...empty, unavailable: true } }];
  const unavailable = render(view());
  expect(await unavailable.findByText(zh.inboxUnavailable)).toBeTruthy();
  expect(unavailable.getByText(zh.loadFailed)).toBeTruthy();
  expect(unavailable.container.querySelector(".inbox-layout")).toBeNull();
  unavailable.unmount();

  inboxes = [{ status: 503, body: {} }];
  const failed = render(view());
  expect(await failed.findByText("Error: /api/inbox?project=demo → HTTP 503")).toBeTruthy();
  expect(failed.queryByText(zh.loadingInbox)).toBeNull();
  expect(failed.container.querySelector(".inbox-layout")).toBeNull();
});

test("an empty inbox says so and a query narrows the index without unmounting the cards", async () => {
  const blank = await open([{ body: empty }]);
  expect(blank.container.querySelector(".inbox-index")!.textContent)
    .toBe(zh.inboxEmptyDecision + t("inboxFlow", { raised: 5, closed: 2 }));
  expect(blank.container.querySelector(".inbox-detail")!.textContent).toBe(zh.inboxEmpty);
  expect(blank.container.querySelector(".inbox-reading")).toBeNull();
  blank.unmount();

  const { container, card, rerender } = await open([{ body: full }]);
  const items = () => texts(container.querySelectorAll(".inbox-item p"));
  rerender(view({ query: " inbox-002 " }));
  expect(items()).toEqual(["Question 11"]);
  rerender(view({ query: "13" }));
  expect(items()).toEqual(["Question 13"]);
  expect(texts(container.querySelectorAll(".inbox-index h2"))).toEqual([`${zh.decision} 1`]);
  expect(within(card()).getByText("#13")).toBeTruthy();

  rerender(view({ query: "nothing matches" }));
  expect(items()).toEqual([]);
  expect(within(container.querySelector(".inbox-detail") as HTMLElement).getByText(zh.inboxNoMatches)).toBeTruthy();
  expect((container.querySelector(".inbox-reading") as HTMLElement).hidden).toBe(true);
  expect(container.querySelectorAll(".ask-card")).toHaveLength(4);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a failed refresh keeps the cards under a notice, and each project reads its own inbox", async () => {
  const { container, rerender, user } = await open([{ body: only(accept) }, new Error("refresh failed")]);
  await user.click(screen.getByRole("button", { name: zh.acknowledge }));
  expect(await screen.findByText(t("inboxRefreshFailed", { error: "Error: refresh failed" }))).toBeTruthy();
  expect(container.querySelectorAll(".ask-card")).toHaveLength(1);
  expect(disabled(zh.acknowledge)).toBe(false);

  inboxes = [{ body: empty }];
  rerender(view({ project: "" }));
  expect(screen.getByText(zh.loadingInbox)).toBeTruthy();
  await act(async () => {});
  rerender(view({ project: null }));
  await waitFor(() => expect(container.querySelector(".inbox-layout")).toBeTruthy());
  expect(urls().slice(-2)).toEqual(["/api/inbox?unassigned=1", "/api/inbox"]);
});
