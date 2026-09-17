import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { fetchModules } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ModuleTask, ModulesResponse } from "@/lib/types";

// 本文件是 nawaban/board_view.py MODULES_PAGE 内嵌 JS(index/rail/layers/
// blocked/card/wires,逻辑已由用户点验定稿)的直接翻译,不重新设计布局算法。

const ST = ["done", "staging-verified", "in_progress", "claimed", "open"] as const;
type Status = (typeof ST)[number];
const STATUS_COLOR: Record<Status, string> = {
  done: "#2e9e6b",
  "staging-verified": "#fbbf24",
  in_progress: "#2f7de1",
  claimed: "#8a5cf6",
  open: "#98a1b0",
};
const STATUS_LABEL: Record<Status, string> = {
  done: "完成",
  "staging-verified": "待验收",
  in_progress: "进行中",
  claimed: "已认领",
  open: "待认领",
};
const isStatus = (s: string): s is Status => (ST as readonly string[]).includes(s);
const statusColor = (s: string) => (isStatus(s) ? STATUS_COLOR[s] : STATUS_COLOR.open);

type Counts = Record<Status, number>;
function countBy(list: ModuleTask[]): Counts {
  const c: Counts = { done: 0, "staging-verified": 0, in_progress: 0, claimed: 0, open: 0 };
  for (const t of list) if (isStatus(t.s)) c[t.s]++;
  return c;
}
function donePct(c: Counts) {
  const tot = ST.reduce((a, s) => a + c[s], 0);
  return tot ? Math.round((100 * c.done) / tot) : 0;
}

type EpicGroup = { epic: string; tasks: ModuleTask[]; counts: Counts };

function groupByEpic(tasks: ModuleTask[]): EpicGroup[] {
  const m = new Map<string, ModuleTask[]>();
  for (const t of tasks) {
    const key = t.e && t.e !== "n/a" ? t.e : "未分组";
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(t);
  }
  const out = [...m].map(([epic, ts]) => ({ epic, tasks: ts, counts: countBy(ts) }));
  out.sort((a, b) => {
    const oa = a.tasks.length - a.counts.done;
    const ob = b.tasks.length - b.counts.done;
    return ob - oa || b.tasks.length - a.tasks.length;
  });
  return out;
}

// 全局依赖索引:upOf(t) = t depends_on 的上游 id;downOf(t) = 依赖 t 的下游 id。
function buildIndex(data: ModulesResponse) {
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
type Index = ReturnType<typeof buildIndex>;

// 被挡 = 未完成且某个上游未完成——跨模块的上游也算,判据是全局的。
function isBlocked(t: ModuleTask, idx: Index): boolean {
  if (t.s === "done") return false;
  return (idx.upOf.get(t.i) ?? []).some((u) => idx.byId.get(u)?.s !== "done");
}

// 按 depends_on 分层:第 0 层 = 组内没有(组内)上游的根,层数向下游递增。
function layers(list: ModuleTask[], idx: Index) {
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

function matches(t: ModuleTask, q: string) {
  const s = q.toLowerCase();
  return t.i.toLowerCase().includes(s) || t.t.toLowerCase().includes(s) || t.e.toLowerCase().includes(s);
}

function Card({
  t,
  ids,
  idx,
  dim,
  hot,
  onClick,
}: {
  t: ModuleTask;
  ids: Set<string>;
  idx: Index;
  dim: boolean;
  hot: boolean;
  onClick: () => void;
}) {
  const xdep = new Set(
    (idx.upOf.get(t.i) ?? [])
      .filter((u) => !ids.has(u))
      .map((u) => {
        const e = idx.byId.get(u)?.e;
        return e && e !== "n/a" ? e : "未分组";
      })
  );
  const blocked = isBlocked(t, idx);
  return (
    <button
      className={cn(
        "flex w-full flex-col gap-2 rounded-md border border-panel-border bg-panel p-3 text-left transition-opacity hover:border-card-hover-border",
        hot && "border-[#5e6ad2] shadow-[0_0_0_1px_#5e6ad2]",
        dim && "opacity-[.22]"
      )}
      data-card-id={t.i}
      onClick={onClick}
      type="button"
    >
      <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: statusColor(t.s) }} />
        <span className="truncate">{t.i}</span>
      </div>
      <p className={cn("m-0 text-ui leading-5 font-medium text-fg-secondary", t.s === "done" && "text-muted-foreground")}>{t.t}</p>
      {(blocked || t.s === "in_progress" || t.s === "staging-verified" || xdep.size > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {blocked && <span className="text-xs text-warn-foreground">▸ 被挡</span>}
          {t.s === "in_progress" && <span className="text-xs" style={{ color: STATUS_COLOR.in_progress }}>进行中</span>}
          {t.s === "staging-verified" && <span className="text-xs" style={{ color: STATUS_COLOR["staging-verified"] }}>待验收</span>}
          {[...xdep].map((e) => (
            <Badge className="border-border text-[11px] text-muted-foreground" key={e} variant="outline">
              ← 依赖 {e}
            </Badge>
          ))}
        </div>
      )}
    </button>
  );
}

export function ModulesView({
  query,
  onSelectTask,
}: {
  query: string;
  onSelectTask: (id: string) => void;
}) {
  const [data, setData] = useState<ModulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState({ w: 0, h: 0, normal: "", hot: "" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    fetchModules()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    const onResize = () => setTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const idx = useMemo(() => (data ? buildIndex(data) : null), [data]);
  const epics = useMemo(() => (data ? groupByEpic(data.tasks) : []), [data]);
  const current = epics.find((e) => e.epic === selected) ?? epics[0] ?? null;
  const q = query.trim();

  const { cols, loose, ids, stageOf } = useMemo(() => {
    if (!current || !idx)
      return {
        cols: [] as ModuleTask[][],
        loose: [] as ModuleTask[],
        ids: new Set<string>(),
        stageOf: new Map<string, number>(),
      };
    const { cols, loose } = layers(current.tasks, idx);
    const ids = new Set(current.tasks.map((t) => t.i));
    const stageOf = new Map<string, number>();
    cols.forEach((col, i) => col.forEach((t) => stageOf.set(t.i, i + 1)));
    return { cols, loose, ids, stageOf };
  }, [current, idx]);

  // 专注模式:选中卡的全部上下游(全局链,不限于当前模块)。
  const focusSet = useMemo(() => {
    if (!focusMode || !focusId || !idx) return null;
    const set = new Set([focusId]);
    const walk = (id: string, m: Map<string, string[]>) => {
      for (const n of m.get(id) ?? []) if (!set.has(n)) { set.add(n); walk(n, m); }
    };
    walk(focusId, idx.upOf);
    walk(focusId, idx.downOf);
    return set;
  }, [focusMode, focusId, idx]);

  // 连线:全局 deps 里两端都渲染在当前 wrap 内的才画——独立卡区在 wrap 外,天然不连线。
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !data) { setWires({ w: 0, h: 0, normal: "", hot: "" }); return; }
    const wr = wrap.getBoundingClientRect();
    const pos = new Map<string, DOMRect>();
    wrap.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
      pos.set(el.dataset.cardId!, el.getBoundingClientRect());
    });
    let normal = "";
    let hot = "";
    for (const [s, d] of data.deps) {
      const ra = pos.get(d); // 上游
      const rb = pos.get(s); // 下游
      if (!ra || !rb) continue;
      const x1 = ra.right - wr.left, y1 = ra.top + ra.height / 2 - wr.top;
      const x2 = rb.left - wr.left, y2 = rb.top + rb.height / 2 - wr.top;
      const m = (x1 + x2) / 2;
      const seg = `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2} `;
      if (focusSet && focusSet.has(s) && focusSet.has(d)) hot += seg;
      else normal += seg;
    }
    setWires({ w: wrap.scrollWidth, h: wrap.scrollHeight, normal, hot });
  }, [data, cols, loose, focusSet, tick]);

  if (error) return <p className="p-4 text-sm text-destructive">模块加载失败:{error}</p>;
  if (!data || !idx) return <p className="p-4 text-sm text-muted-foreground">加载中…</p>;
  if (data.unavailable) return <p className="p-4 text-sm text-muted-foreground">模块数据当前不可用</p>;

  const list = current?.tasks ?? [];
  const c = current?.counts ?? countBy([]);
  const wip = list.filter((t) => t.s === "in_progress" || t.s === "claimed");
  const nowLine = wip.length
    ? "现在动着的:" +
      wip
        .map((t) => `${t.i}${stageOf.has(t.i) ? `(第 ${stageOf.get(t.i)}/${cols.length} 级)` : "(独立卡)"}`)
        .join(" · ")
    : "没有进行中的卡";

  const cardOnClick = (id: string) => {
    if (focusMode) setFocusId((cur) => (cur === id ? null : id));
    else onSelectTask(id);
  };
  const dimOf = (t: ModuleTask) => (focusSet ? !focusSet.has(t.i) : q ? !matches(t, q) : false);
  const hotOf = (t: ModuleTask) => focusSet != null && t.i === focusId;

  return (
    <div className="grid h-full grid-cols-[280px_1fr]">
      <ScrollArea className="border-r">
        <div className="flex flex-col px-2 py-3">
          <div className="flex h-7 items-center px-2 text-xs font-medium text-muted-foreground">
            模块 · 按未完成量排序
          </div>
          {epics.map((e) => {
            const total = e.tasks.length;
            const active = current?.epic === e.epic;
            return (
              <button
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-2 text-left text-ui font-medium transition-colors",
                  active ? "bg-accent text-foreground" : "text-fg-secondary hover:bg-accent/50"
                )}
                key={e.epic}
                onClick={() => { setSelected(e.epic); setFocusId(null); }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{e.epic}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {total - e.counts.done}/{total}
                </span>
                <div className="flex h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border">
                  {ST.map((s) =>
                    e.counts[s] ? (
                      <span
                        key={s}
                        style={{ width: `${(100 * e.counts[s]) / total}%`, background: STATUS_COLOR[s] }}
                      />
                    ) : null
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </ScrollArea>

      <ScrollArea className="h-full">
        {current ? (
          <div className="flex flex-col gap-4 px-6 py-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-2xl leading-8 font-semibold">{current.epic}</h2>
                <p className="mt-1 text-ui text-muted-foreground">
                  {list.length} 卡 · 完成 {donePct(c)}% · done {c.done} / 待验收 {c["staging-verified"]} /
                  进行中 {c.in_progress + c.claimed} / open {c.open} · {nowLine}
                </p>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground select-none">
                专注模式 · 点卡看它的链
                <Switch
                  checked={focusMode}
                  onCheckedChange={(checked) => { setFocusMode(checked); setFocusId(null); }}
                  size="sm"
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              {ST.map((s) => (
                <span className="flex items-center gap-1" key={s}>
                  <span className="inline-block size-2 rounded-sm" style={{ background: STATUS_COLOR[s] }} />
                  {STATUS_LABEL[s]}
                </span>
              ))}
              <span className="text-[#fbbf24]">▸ 被挡 = 上游未 done</span>
            </div>

            <div className="relative overflow-x-auto pb-2" ref={wrapRef}>
              <svg
                className="pointer-events-none absolute inset-0 overflow-visible"
                height={wires.h}
                width={wires.w}
              >
                {wires.normal && (
                  <path
                    d={wires.normal}
                    fill="none"
                    opacity={focusSet ? 0.18 : 1}
                    stroke="#3f3f46"
                    strokeWidth={1.2}
                  />
                )}
                {wires.hot && <path d={wires.hot} fill="none" stroke="#5e6ad2" strokeWidth={1.8} />}
              </svg>
              {cols.length > 0 ? (
                <div className="relative flex w-max items-start gap-11">
                  {cols.map((col, i) => (
                    <div className="w-[250px] shrink-0" key={i}>
                      <div className="flex h-7 items-center px-1 text-xs font-medium text-muted-foreground">
                        第 {i + 1} 级{i === 0 ? " · 上游" : i === cols.length - 1 ? " · 下游" : ""}
                      </div>
                      <div className="flex flex-col gap-2 py-1">
                        {col.map((t) => (
                          <Card
                            dim={dimOf(t)}
                            hot={hotOf(t)}
                            idx={idx}
                            ids={ids}
                            key={t.i}
                            onClick={() => cardOnClick(t.i)}
                            t={t}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-8 text-sm text-muted-foreground">
                  这个模块内部没有依赖链——所有卡都是独立卡。
                </p>
              )}
            </div>

            {loose.length > 0 && (
              <div className="mt-2 border-t pt-4">
                <h3 className="mb-2 flex h-7 items-center text-xs font-medium text-muted-foreground">
                  独立卡(不在链上)· {loose.length}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {ST.flatMap((s) => loose.filter((t) => t.s === s)).map((t) => (
                    <div className="w-[250px]" key={t.i}>
                      <Card
                        dim={dimOf(t)}
                        hot={hotOf(t)}
                        idx={idx}
                        ids={ids}
                        onClick={() => cardOnClick(t.i)}
                        t={t}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">没有模块数据</p>
        )}
      </ScrollArea>
    </div>
  );
}
