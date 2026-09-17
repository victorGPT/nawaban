import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Chip } from "@/components/base/badges/chip";
import { TaskCard, TaskTag, StatusLegend } from "@/components/TaskCard";
import { useReadOnlyData } from "@/lib/use-read-only-data";
import { ContentButton, LoadState } from "@/components/NawabanUI";
import { Switch } from "@/components/base/switch/switch";
import { fetchModules, type Project } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { ModuleTask } from "@/lib/types";

// Preserve the embedded module view graph algorithm from board_view.py.

import {
  ST,
  countBy,
  donePct,
  groupByEpic,
  buildIndex,
  dependencyWire,
  isBlocked,
  layers,
  type Index,
} from "@/lib/modules-model";
type Status = (typeof ST)[number];
const STATUS_COLOR = {
  done: "soft",
  "staging-verified": "yellow",
  in_progress: "blue",
  claimed: "soft",
  open: "soft",
} as const;
const STATUS_LABEL: Record<Status, string> = {
  done: "完成",
  "staging-verified": "待验收",
  in_progress: "进行中",
  claimed: "已认领",
  open: "待认领",
};
const isStatus = (s: string): s is Status =>
  (ST as readonly string[]).includes(s);
function StageTag({ status }: { status: string }) {
  return <Chip color={isStatus(status) ? STATUS_COLOR[status] : "soft"} variant="bold">
    {isStatus(status) ? STATUS_LABEL[status] : status === "cancelled" ? "已取消" : status}
  </Chip>;
}

function matches(t: ModuleTask, q: string) {
  const s = q.toLowerCase();
  return (
    t.i.toLowerCase().includes(s) ||
    t.t.toLowerCase().includes(s) ||
    t.e.toLowerCase().includes(s)
  );
}

function Card({
  t,
  ids,
  idx,
  dim,
  hot,
  onClick,
  hasAsk,
  onDecision,
}: {
  t: ModuleTask;
  ids: Set<string>;
  idx: Index;
  dim: boolean;
  hot: boolean;
  onClick: () => void;
  hasAsk: boolean;
  onDecision: () => void;
}) {
  const xdep = new Set(
    (idx.upOf.get(t.i) ?? [])
      .filter((u) => !ids.has(u))
      .map((u) => {
        const e = idx.byId.get(u)?.e;
        return e && e !== "n/a" ? e : "未分组";
      }),
  );
  const blocked = isBlocked(t, idx);
  return (
    <TaskCard
      task={{ id: t.i, title: t.t, status: t.s, epic: t.e, live: t.live, waiting_on: t.waiting_on ?? null }}
      hasAsk={hasAsk} onSelect={onClick} onDecision={onDecision}
      className={cn("transition-opacity", hot && "ring-1 ring-border-focus-ring", dim && "opacity-[.22]")}
    >
      <StageTag status={t.s} />
      {blocked && <Chip color="yellow" variant="bold">被挡</Chip>}
      {[...xdep].map((e) => <TaskTag label={`依赖 ${e}`} key={e} />)}
    </TaskCard>
  );
}

export function ModulesView({
  query,
  onSelectTask,
  onDecision,
  decisionTasks,
  project,
}: {
  query: string;
  onSelectTask: (id: string) => void;
  onDecision: (id: string) => void;
  decisionTasks: Set<string>;
  project: Project;
}) {
  const loadModules = useCallback(() => fetchModules(project), [project]);
  const { data, error } = useReadOnlyData(loadModules);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("epic"),
  );
  const [focusMode, setFocusMode] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState({ w: 0, h: 0, normal: "", hot: "" });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const onResize = () => setTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const idx = useMemo(() => (data ? buildIndex(data) : null), [data]);
  const epics = useMemo(() => (data ? groupByEpic(data.tasks) : []), [data]);
  const current = epics.find((e) => e.epic === selected) ?? epics[0] ?? null;
  useEffect(() => {
    if (current && selected !== current.epic) setSelected(current.epic);
  }, [selected, current]);
  const currentEpic = current?.epic;
  useEffect(() => {
    if (currentEpic === undefined) return;
    const url = new URL(location.href);
    url.searchParams.set("epic", currentEpic);
    history.replaceState(null, "", url);
  }, [currentEpic]);
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

  // Focus follows all upstream and downstream links, including other modules.
  const focusSet = useMemo(() => {
    if (!focusMode || !focusId || !idx) return null;
    const set = new Set([focusId]);
    const walk = (id: string, m: Map<string, string[]>) => {
      for (const n of m.get(id) ?? [])
        if (!set.has(n)) {
          set.add(n);
          walk(n, m);
        }
    };
    walk(focusId, idx.upOf);
    walk(focusId, idx.downOf);
    return set;
  }, [focusMode, focusId, idx]);

  // Draw edges only when both endpoints are inside the graph wrapper.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !data) {
      setWires({ w: 0, h: 0, normal: "", hot: "" });
      return;
    }
    const wr = wrap.getBoundingClientRect();
    const pos = new Map<string, DOMRect>();
    wrap.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
      pos.set(el.dataset.cardId!, el.getBoundingClientRect());
    });
    let normal = "";
    let hot = "";
    for (const [s, d] of data.deps) {
      const ra = pos.get(d); // Upstream
      const rb = pos.get(s); // Downstream
      if (!ra || !rb) continue;
      const seg = dependencyWire(ra, rb, {
        left: wr.left, top: wr.top,
        scrollLeft: wrap.scrollLeft, scrollTop: wrap.scrollTop,
      });
      if (focusSet && focusSet.has(s) && focusSet.has(d)) hot += seg;
      else normal += seg;
    }
    setWires({ w: wrap.scrollWidth, h: wrap.scrollHeight, normal, hot });
  }, [data, cols, loose, focusSet, tick]);

  if (error) return <LoadState error>{error}</LoadState>;
  if (!data || !idx) return <LoadState>正在读取依赖关系…</LoadState>;
  if (data.unavailable)
    return (
      <p className="p-4 text-body-regular text-text-secondary">
        模块数据当前不可用
      </p>
    );

  const list = current?.tasks ?? [];
  const c = current?.counts ?? countBy([]);
  const wip = list.filter((t) => t.s === "in_progress" || t.s === "claimed");
  const nowLine = wip.length
    ? "进行中：" +
      wip
        .map(
          (t) =>
            `${t.i}${stageOf.has(t.i) ? `(第 ${stageOf.get(t.i)}/${cols.length} 级)` : "(独立卡)"}`,
        )
        .join(" · ")
    : "没有进行中的卡";

  const cardOnClick = (id: string) => {
    if (focusMode) setFocusId((cur) => (cur === id ? null : id));
    else onSelectTask(id);
  };
  const dimOf = (t: ModuleTask) =>
    focusSet ? !focusSet.has(t.i) : q ? !matches(t, q) : false;
  const hotOf = (t: ModuleTask) => focusSet != null && t.i === focusId;

  return (
    <div className="modules-layout">
      <div className="module-rail">
        <div className="flex flex-col px-2 py-3">
          <div className="flex h-7 items-center px-2 text-body-medium text-text-secondary">
            模块 · 未完成 / 总数
          </div>
          {epics.map((e) => {
            const total = e.tasks.length;
            const active = current?.epic === e.epic;
            return (
              <ContentButton
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-2 text-left text-body-regular transition-colors",
                  active
                    ? "bg-background-secondary-hover text-text-primary"
                    : "text-text-primary hover:bg-background-secondary-hover/50",
                )}
                key={e.epic}
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  setSelected(e.epic);
                  setFocusId(null);
                }}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{e.epic}</span>
                <span className="shrink-0 text-body-regular text-text-secondary">
                  {total - e.counts.done}/{total}
                </span>
              </ContentButton>
            );
          })}
        </div>
      </div>

      <div className="module-graph-scroll">
        {current ? (
          <div className="flex flex-col gap-4 px-6 py-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <h2 className="text-title-1-semibold">{current.epic}</h2>
                <p className="mt-1 text-body-regular text-text-secondary">
                  {list.length} 卡 · 完成 {donePct(c)}% · 完成 {c.done} / 待验收{" "}
                  {c["staging-verified"]} / 进行中 {c.in_progress + c.claimed} /
                  待认领 {c.open}
                </p>
                <p className="mt-2 text-body-regular text-text-secondary break-words">
                  {nowLine}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-body-regular text-text-secondary select-none">
                专注模式
                <Switch
                  aria-label="专注模式 · 点卡看它的链"
                  isSelected={focusMode}
                  onChange={(checked) => {
                    setFocusMode(checked);
                    setFocusId(null);
                  }}
                  size="sm"
                />
              </div>
            </div>

            <StatusLegend available={data.liveness?.available} />

            <div className="relative overflow-x-auto pb-2" ref={wrapRef}>
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 overflow-visible"
                height={wires.h}
                width={wires.w}
              >
                {wires.normal && (
                  <path
                    d={wires.normal}
                    fill="none"
                    opacity={focusSet ? 0.18 : 1}
                    stroke="var(--color-text-tertiary)"
                    strokeWidth={1.2}
                  />
                )}
                {wires.hot && (
                  <path
                    d={wires.hot}
                    fill="none"
                    stroke="var(--color-accent-500)"
                    strokeWidth={1.8}
                  />
                )}
              </svg>
              {cols.length > 0 ? (
                <div className="relative flex w-max items-start gap-11">
                  {cols.map((col, i) => (
                    <div className="w-[250px] shrink-0" key={i}>
                      <div className="flex h-7 items-center px-1 text-body-medium text-text-secondary">
                        第 {i + 1} 级
                        {i === 0
                          ? " · 上游"
                          : i === cols.length - 1
                            ? " · 下游"
                            : ""}
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
                          hasAsk={decisionTasks.has(t.i)}
                          onDecision={() => onDecision(t.i)}
                            t={t}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-8 text-body-regular text-text-secondary">
                  这个模块内部没有依赖链——所有卡都是独立卡。
                </p>
              )}
            </div>

            {loose.length > 0 && (
              <div className="mt-2 border-t pt-4">
                <h3 className="mb-2 flex h-7 items-center text-body-medium text-text-secondary">
                  独立卡(不在链上)· {loose.length}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {ST.flatMap((s) => loose.filter((t) => t.s === s)).map(
                    (t) => (
                      <div className="w-[250px]" key={t.i}>
                        <Card
                          dim={dimOf(t)}
                          hot={hotOf(t)}
                          idx={idx}
                          ids={ids}
                          onClick={() => cardOnClick(t.i)}
                          hasAsk={decisionTasks.has(t.i)}
                          onDecision={() => onDecision(t.i)}
                          t={t}
                        />
                      </div>
                    ),
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="p-4 text-body-regular text-text-secondary">
            没有模块数据
          </p>
        )}
      </div>
    </div>
  );
}
