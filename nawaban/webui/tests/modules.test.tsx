import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ModulesView } from "@/views/modules";
import { t } from "@/i18n";
import zh from "@/i18n/zh-CN.json";
import { fetchModules } from "@/lib/api";
import { dependencyWire } from "@/lib/modules-model";
import { TASK_REFRESH_MS } from "@/lib/poll-read-only";
import type { ModuleTask, ModulesResponse } from "@/lib/types";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(), fetchModules: vi.fn(),
}));

const task = (i: string, title: string, s: string, e = i.split("-")[0]): ModuleTask => ({ i, t: title, s, e });
// CORE chains 1 -> 2 -> 3 and 1 -> 6; CORE-3 also waits on EDGE-1 in another module.
const data: ModulesResponse = {
  tasks: [
    task("CORE-1", "Lay the foundation", "done"), task("CORE-2", "Build the walls", "in_progress"),
    task("CORE-3", "Raise the roof", "open"), task("CORE-4", "Paint the fence", "claimed"),
    task("CORE-5", "Sweep the yard", "done"), task("CORE-6", "Plant the hedge", "open"),
    task("EDGE-1", "Order the timber", "open"), task("EDGE-2", "Hire the crew", "staging-verified"),
    task("LOOSE-1", "Loose end", "open", ""),
  ],
  deps: [["CORE-2", "CORE-1"], ["CORE-3", "CORE-2"], ["CORE-3", "EDGE-1"], ["CORE-6", "CORE-1"]],
};
const other: ModulesResponse = {
  tasks: [task("NEW-1", "Another project task", "open"), task("NEW-2", "Its neighbour", "open"), task("EDGE-9", "Shared module name", "open")],
  deps: [],
};

beforeEach(() => {
  vi.useRealTimers();
  vi.mocked(fetchModules).mockReset().mockResolvedValue(data);
});

function view(props: Partial<Parameters<typeof ModulesView>[0]> = {}) {
  return <ModulesView query="" project={null} decisionTasks={new Set()}
    onSelectTask={() => {}} onDecision={() => {}} {...props} />;
}
async function open(props: Parameters<typeof view>[0] = {}) {
  const result = render(view(props));
  await screen.findByRole("heading", { level: 2 });
  return result;
}
const texts = (elements: Iterable<Element>) => [...elements].map((element) => element.textContent);
const cardIds = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>("[data-card-id]")].map((card) => card.dataset.cardId);
const withClass = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLElement>("[data-card-id]")]
    .filter((card) => card.querySelector(".task-card")!.className.includes(name)).map((card) => card.dataset.cardId);
const dimmed = (root: ParentNode) => withClass(root, "opacity-[.22]");
const cardButton = (id: string) => screen.getByRole("button", { name: new RegExp(`^${t("viewTask", { id, title: "" })}`) });
const railButton = (name: string) => within(document.querySelector(".module-rail") as HTMLElement).getByRole("button", { name: new RegExp(`^${name}`) });
const title = () => screen.getByRole("heading", { level: 2 }).textContent;
const epicParam = () => new URLSearchParams(location.search).get("epic");

test("the rail lists modules by unfinished work and the first one opens as stages plus independent cards", async () => {
  const { container } = await open();
  const rail = container.querySelector(".module-rail") as HTMLElement;
  expect(rail.textContent!.startsWith(zh.moduleRailTitle)).toBe(true);
  const modules = within(rail).getAllByRole("button");
  expect(texts(modules)).toEqual(["CORE4/6", "EDGE2/2", `${zh.ungrouped}1/1`]);
  expect(modules.map((module) => module.getAttribute("aria-current"))).toEqual(["true", null, null]);

  expect(title()).toBe("CORE");
  expect(epicParam()).toBe("CORE");
  expect(screen.getByText(t("moduleSummary", { count: 6, percent: 33, done: 2, ready: 0, assigned: 1, active: 1, open: 2 }))).toBeTruthy();
  expect(screen.getByText(`${zh.currentWork}CORE-2${t("stageOf", { stage: 2, total: 3 })} · CORE-4${zh.independentSuffix}`)).toBeTruthy();
  expect(screen.getByLabelText(zh.statusLegend)).toBeTruthy();

  const stages = [...container.querySelectorAll(".w-max > div")];
  expect(stages.map((stage) => stage.firstElementChild!.textContent)).toEqual([
    `${t("stage", { stage: 1 })}${zh.upstreamSuffix}`, t("stage", { stage: 2 }), `${t("stage", { stage: 3 })}${zh.downstreamSuffix}`,
  ]);
  expect(stages.map(cardIds)).toEqual([["CORE-1"], ["CORE-2", "CORE-6"], ["CORE-3"]]);
  expect(cardButton("CORE-3").textContent).toBe("Raise the roof");

  // Independent cards follow the status order, not the API order.
  const independent = screen.getByRole("heading", { level: 3 });
  expect(independent.textContent).toBe(`${zh.independent}2`);
  expect(cardIds(independent.parentElement!)).toEqual(["CORE-5", "CORE-4"]);
  const claimed = container.querySelector('[data-card-id="CORE-4"]') as HTMLElement;
  expect(within(claimed).queryByText(zh.assigned)).toBeNull();
});

test("dependency wires join cards inside the open module, follow a resize and split when a chain is focused", async () => {
  const user = userEvent.setup();
  let spread = 300;
  const rect = (id?: string) => {
    const n = id ? Number(id.at(-1)) : 0;
    return { left: n * spread, right: n * spread + 250, top: n * 10, height: 60 } as DOMRect;
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rect((this as HTMLElement).dataset?.cardId);
  });
  const origin = { left: 0, top: 0, scrollLeft: 0, scrollTop: 0 };
  const wire = (upstream: string, downstream: string) => dependencyWire(rect(upstream), rect(downstream), origin);
  const { container } = await open();
  const svg = container.querySelector("svg.pointer-events-none")!;
  const paths = () => [...svg.querySelectorAll("path")];

  // The EDGE-1 -> CORE-3 dependency has no card here, so it draws nothing.
  expect(paths()).toHaveLength(1);
  expect(paths()[0].getAttribute("d")).toBe(wire("CORE-1", "CORE-2") + wire("CORE-2", "CORE-3") + wire("CORE-1", "CORE-6"));
  expect(["stroke", "stroke-width", "opacity", "fill"].map((name) => paths()[0].getAttribute(name)))
    .toEqual(["var(--color-text-tertiary)", "1.2", "1", "none"]);
  expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["0", "0"]);

  const before = paths()[0].getAttribute("d");
  spread = 400;
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(paths()[0].getAttribute("d")).not.toBe(before);
  expect(paths()[0].getAttribute("d")).toBe(wire("CORE-1", "CORE-2") + wire("CORE-2", "CORE-3") + wire("CORE-1", "CORE-6"));

  await user.click(screen.getByRole("switch", { name: zh.focusMode }));
  expect(paths()).toHaveLength(1);
  expect(paths()[0].getAttribute("opacity")).toBe("1");
  await user.click(cardButton("CORE-2"));
  expect(paths().map((path) => path.getAttribute("d"))).toEqual([wire("CORE-1", "CORE-6"), wire("CORE-1", "CORE-2") + wire("CORE-2", "CORE-3")]);
  expect(paths().map((path) => path.getAttribute("opacity"))).toEqual(["0.18", null]);
  expect(["stroke", "stroke-width"].map((name) => paths()[1].getAttribute(name))).toEqual(["var(--color-accent-500)", "1.8"]);

  await user.click(railButton("EDGE"));
  expect(paths()).toHaveLength(0);
});

test("a search dims every card that matches neither by ID, title nor module", async () => {
  const { container, rerender } = await open({ query: "  ROOF " });
  expect(dimmed(container)).toEqual(["CORE-1", "CORE-2", "CORE-6", "CORE-5", "CORE-4"]);
  expect(container.querySelector('[data-card-id="CORE-3"] .task-card')!.className).toContain("transition-opacity");
  rerender(view({ query: "core-4" }));
  expect(dimmed(container)).toEqual(["CORE-1", "CORE-2", "CORE-6", "CORE-3", "CORE-5"]);
  rerender(view({ query: "core" }));
  expect(dimmed(container)).toEqual([]);
  rerender(view({ query: "nothing matches" }));
  expect(dimmed(container)).toHaveLength(6);
  expect(within(container.querySelector(".module-rail") as HTMLElement).getAllByRole("button")).toHaveLength(3);
  rerender(view({ query: "   " }));
  expect(dimmed(container)).toEqual([]);
});

test("a search for the module name keeps a card whose ID and title do not mention it", async () => {
  vi.mocked(fetchModules).mockResolvedValue({ tasks: [task("T-1", "Trim the hedge", "open", "Garden")], deps: [] });
  const { container, rerender } = await open({ query: "garden" });
  expect(dimmed(container)).toEqual([]);
  rerender(view({ query: "kitchen" }));
  expect(dimmed(container)).toEqual(["T-1"]);
});

test("focus mode turns a card click into its upstream and downstream chain instead of opening the task", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  const { container } = await open({ onSelectTask: select, query: "fence" });
  const focus = screen.getByRole("switch", { name: zh.focusMode });
  expect(focus.parentElement!.textContent).toBe(zh.focusModeLabel);
  expect(focus.getAttribute("aria-checked")).toBe("false");

  await user.click(focus);
  expect(focus.getAttribute("aria-checked")).toBe("true");
  // Until a card is picked, the search still decides what is dimmed.
  expect(dimmed(container)).toEqual(["CORE-1", "CORE-2", "CORE-6", "CORE-3", "CORE-5"]);

  await user.click(cardButton("CORE-2"));
  expect(select).not.toHaveBeenCalled();
  expect(dimmed(container)).toEqual(["CORE-6", "CORE-5", "CORE-4"]);
  expect(withClass(container, "ring-1 ring-border-focus-ring")).toEqual(["CORE-2"]);
  await user.click(cardButton("CORE-6"));
  expect(dimmed(container)).toEqual(["CORE-2", "CORE-3", "CORE-5", "CORE-4"]);
  expect(withClass(container, "ring-1")).toEqual(["CORE-6"]);
  await user.click(cardButton("CORE-6"));
  expect(withClass(container, "ring-1")).toEqual([]);
  expect(dimmed(container)).toEqual(["CORE-1", "CORE-2", "CORE-6", "CORE-3", "CORE-5"]);

  // Changing module or leaving focus mode forgets the picked card.
  await user.click(cardButton("CORE-2"));
  await user.click(railButton("EDGE"));
  await user.click(railButton("CORE"));
  expect(withClass(container, "ring-1")).toEqual([]);
  await user.click(cardButton("CORE-2"));
  await user.click(focus);
  await user.click(focus);
  expect(withClass(container, "ring-1")).toEqual([]);
  await user.click(focus);
  await user.click(cardButton("CORE-2"));
  expect(select).toHaveBeenCalledExactlyOnceWith("CORE-2");
});

test("Tab walks the rail, the focus switch, then cards stage by stage, and Enter opens the card or its decision", async () => {
  const user = userEvent.setup();
  const select = vi.fn(), decide = vi.fn();
  await open({ onSelectTask: select, onDecision: decide, decisionTasks: new Set(["CORE-3"]) });
  const order: (string | null)[] = [];
  for (let step = 0; step < 11; step++) {
    await user.tab();
    order.push(document.activeElement!.getAttribute("aria-label") ?? document.activeElement!.textContent);
    if (step === 4) await user.keyboard("{Enter}");
    if (step === 8) await user.keyboard("{Enter}");
  }
  const label = (id: string) => t("viewTask", { id, title: data.tasks.find((item) => item.i === id)!.t });
  expect(order).toEqual([
    "CORE4/6", "EDGE2/2", `${zh.ungrouped}1/1`, zh.focusMode,
    label("CORE-1"), label("CORE-2"), label("CORE-6"), label("CORE-3"), zh.waitDecision, label("CORE-5"), label("CORE-4"),
  ]);
  expect(select).toHaveBeenCalledExactlyOnceWith("CORE-1");
  expect(decide).toHaveBeenCalledExactlyOnceWith("CORE-3");
});

test("the open module comes from the URL, follows rail clicks and reports card clicks", async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  history.replaceState(null, "", "/?view=modules&epic=EDGE");
  const { container } = await open({ onSelectTask: select });
  expect(title()).toBe("EDGE");
  expect(railButton("EDGE").getAttribute("aria-current")).toBe("true");
  expect(screen.getByText(zh.noChain)).toBeTruthy();
  expect(screen.getByText(zh.noInProgress)).toBeTruthy();
  expect(cardIds(container)).toEqual(["EDGE-2", "EDGE-1"]);
  expect(cardIds(screen.getByRole("heading", { level: 3 }).parentElement!)).toEqual(["EDGE-2", "EDGE-1"]);

  await user.click(cardButton("EDGE-1"));
  expect(select).toHaveBeenCalledExactlyOnceWith("EDGE-1");
  await user.click(railButton(zh.ungrouped));
  expect(title()).toBe(zh.ungrouped);
  expect(location.search).toBe(`?view=modules&epic=${encodeURIComponent("未分组")}`);
  expect(cardIds(container)).toEqual(["LOOSE-1"]);
  expect(texts(within(container.querySelector(".module-rail") as HTMLElement).getAllByRole("button")
    .filter((module) => module.getAttribute("aria-current")))).toEqual([`${zh.ungrouped}1/1`]);
});

test("no modules, unavailable module data and missing liveness each say so", async () => {
  vi.mocked(fetchModules).mockResolvedValue({ tasks: [], deps: [] });
  const empty = render(view());
  expect(await screen.findByText(zh.noModules)).toBeTruthy();
  expect(empty.container.querySelector(".module-rail")!.textContent).toBe(zh.moduleRailTitle);
  expect(empty.container.querySelector("[data-card-id], h2, svg")).toBeNull();
  expect(epicParam()).toBeNull();
  empty.unmount();

  vi.mocked(fetchModules).mockResolvedValue({ tasks: data.tasks, deps: [], unavailable: true });
  const unavailable = render(view());
  expect(await screen.findByText(zh.modulesUnavailable)).toBeTruthy();
  expect(unavailable.container.querySelector(".modules-layout")).toBeNull();
  unavailable.unmount();

  vi.mocked(fetchModules).mockResolvedValue({ ...data, liveness: { available: false, complete: false, busy_window_s: 60, idle_window_s: 600 } });
  await open();
  expect(within(screen.getByLabelText(zh.statusLegend)).getByText(zh.signalsUnavailable)).toBeTruthy();
});

test("loading and failed reads replace the view, and the next poll restores it with its focus kept", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  let fail!: (reason: Error) => void;
  vi.mocked(fetchModules).mockReturnValueOnce(new Promise((_, reject) => { fail = reject; }));
  const { container } = render(view());
  expect(screen.getByText(zh.loadingModules)).toBeTruthy();
  expect(container.querySelector(".modules-layout")).toBeNull();
  await act(async () => fail(new Error("modules read failed")));
  expect(screen.getByText("Error: modules read failed")).toBeTruthy();
  expect(screen.getByText(zh.loadFailed)).toBeTruthy();
  expect(screen.queryByText(zh.loadingModules)).toBeNull();

  await act(async () => { await vi.advanceTimersByTimeAsync(TASK_REFRESH_MS); });
  expect(fetchModules).toHaveBeenCalledTimes(2);
  expect(title()).toBe("CORE");
  await user.click(railButton("EDGE"));
  await user.click(screen.getByRole("switch", { name: zh.focusMode }));
  await user.click(cardButton("EDGE-1"));

  vi.mocked(fetchModules).mockRejectedValueOnce(new Error("poll failed"));
  await act(async () => { await vi.advanceTimersByTimeAsync(TASK_REFRESH_MS); });
  expect(screen.getByText("Error: poll failed")).toBeTruthy();
  expect(container.querySelector(".modules-layout")).toBeNull();

  vi.mocked(fetchModules).mockResolvedValueOnce({ ...data, tasks: [...data.tasks, task("EDGE-3", "Polled in later", "open")] });
  await act(async () => { await vi.advanceTimersByTimeAsync(TASK_REFRESH_MS); });
  expect(screen.queryByText("Error: poll failed")).toBeNull();
  expect(title()).toBe("EDGE");
  expect(cardIds(container)).toEqual(["EDGE-2", "EDGE-1", "EDGE-3"]);
  expect(screen.getByRole("switch", { name: zh.focusMode }).getAttribute("aria-checked")).toBe("true");
  expect(withClass(container, "ring-1")).toEqual(["EDGE-1"]);
  expect(dimmed(container)).toEqual(["EDGE-2", "EDGE-3"]);
});

test("switching project re-reads without remounting: the open module survives by name and stale reads are dropped", async () => {
  const user = userEvent.setup();
  let late!: (value: ModulesResponse) => void, next!: (value: ModulesResponse) => void;
  vi.mocked(fetchModules).mockImplementation((project) =>
    project === "slow" ? new Promise((resolve) => { late = resolve; })
      : project === "beta" ? new Promise((resolve) => { next = resolve; }) : Promise.resolve(data));
  const { container, rerender } = render(view({ project: "slow" }));
  expect(screen.getByText(zh.loadingModules)).toBeTruthy();
  rerender(view({ project: null }));
  await screen.findByRole("heading", { level: 2 });
  await act(async () => late(other));
  expect(title()).toBe("CORE");
  await user.click(railButton("EDGE"));

  // The previous project stays on screen until the new one answers.
  rerender(view({ project: "beta" }));
  expect(fetchModules).toHaveBeenLastCalledWith("beta");
  expect(fetchModules).toHaveBeenCalledTimes(3);
  expect(cardIds(container)).toEqual(["EDGE-2", "EDGE-1"]);
  await act(async () => next(other));
  expect(texts(within(container.querySelector(".module-rail") as HTMLElement).getAllByRole("button"))).toEqual(["NEW2/2", "EDGE1/1"]);
  expect(title()).toBe("EDGE");
  expect(cardIds(container)).toEqual(["EDGE-9"]);

  // A module the new project lacks falls back to the first one, in the URL too.
  await user.click(railButton("NEW"));
  rerender(view({ project: null }));
  await screen.findByText("Lay the foundation");
  expect(title()).toBe("CORE");
  expect(epicParam()).toBe("CORE");
});
