import type { ModuleTask, ModulesResponse } from "./types.ts";
export const ST = [
  "done",
  "staging-verified",
  "in_progress",
  "claimed",
  "open",
] as const;
type Status = (typeof ST)[number];
const isStatus = (s: string): s is Status =>
  (ST as readonly string[]).includes(s);
type Counts = Record<Status, number>;
export function countBy(list: ModuleTask[]): Counts {
  const c: Counts = {
    done: 0,
    "staging-verified": 0,
    in_progress: 0,
    claimed: 0,
    open: 0,
  };
  for (const t of list) if (isStatus(t.s)) c[t.s]++;
  return c;
}
export function donePct(c: Counts) {
  const tot = ST.reduce((a, s) => a + c[s], 0);
  return tot ? Math.round((100 * c.done) / tot) : 0;
}

type EpicGroup = { epic: string; tasks: ModuleTask[]; counts: Counts };

export function groupByEpic(tasks: ModuleTask[]): EpicGroup[] {
  const m = new Map<string, ModuleTask[]>();
  for (const t of tasks) {
    const key = t.e && t.e !== "n/a" ? t.e : "未分组";
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(t);
  }
  const out = [...m].map(([epic, ts]) => ({
    epic,
    tasks: ts,
    counts: countBy(ts),
  }));
  out.sort((a, b) => {
    const oa = a.tasks.length - a.counts.done;
    const ob = b.tasks.length - b.counts.done;
    return ob - oa || b.tasks.length - a.tasks.length;
  });
  return out;
}

// Global dependency index: upstream prerequisites and downstream dependents.
export function buildIndex(data: ModulesResponse) {
  const byId = new Map(data.tasks.map((t) => [t.i, t]));
  const upOf = new Map<string, string[]>();
  const downOf = new Map<string, string[]>();
  for (const [s, d] of data.deps) {
    if (!byId.has(s) || !byId.has(d)) continue;
    if (!upOf.has(s)) upOf.set(s, []);
    upOf.get(s)!.push(d);
    if (!downOf.has(d)) downOf.set(d, []);
    downOf.get(d)!.push(s);
  }
  return { byId, upOf, downOf };
}
export type Index = ReturnType<typeof buildIndex>;

type CardRect = { left: number; right: number; top: number; height: number };
export function dependencyWire(
  upstream: CardRect,
  downstream: CardRect,
  viewport: { left: number; top: number; scrollLeft: number; scrollTop: number },
) {
  const x1 = upstream.right - viewport.left + viewport.scrollLeft;
  const y1 = upstream.top + upstream.height / 2 - viewport.top + viewport.scrollTop;
  const x2 = downstream.left - viewport.left + viewport.scrollLeft;
  const y2 = downstream.top + downstream.height / 2 - viewport.top + viewport.scrollTop;
  const middle = (x1 + x2) / 2;
  return `M${x1},${y1} C${middle},${y1} ${middle},${y2} ${x2},${y2} `;
}

// An unfinished upstream prerequisite blocks a task, including across modules.
export function isBlocked(t: ModuleTask, idx: Index): boolean {
  if (t.s === "done") return false;
  return (idx.upOf.get(t.i) ?? []).some((u) => idx.byId.get(u)?.s !== "done");
}

// Layer dependencies from local roots at layer zero toward downstream nodes.
export function layers(list: ModuleTask[], idx: Index) {
  const ids = new Set(list.map((t) => t.i));
  const memo = new Map<string, number>();
  const level = (id: string): number => {
    if (memo.has(id)) return memo.get(id)!;
    memo.set(id, 0);
    const ups = (idx.upOf.get(id) ?? []).filter((u) => ids.has(u));
    const v = ups.length ? 1 + Math.max(...ups.map(level)) : 0;
    memo.set(id, v);
    return v;
  };
  const inChain = (t: ModuleTask) =>
    (idx.upOf.get(t.i) ?? []).some((u) => ids.has(u)) ||
    (idx.downOf.get(t.i) ?? []).some((d) => ids.has(d));
  const chained = list.filter(inChain);
  const loose = list.filter((t) => !inChain(t));
  const cols: ModuleTask[][] = [];
  for (const t of chained) {
    const l = level(t.i);
    (cols[l] ??= []).push(t);
  }
  return { cols, loose };
}
