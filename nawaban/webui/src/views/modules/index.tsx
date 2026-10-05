import { t as tr, useLocale } from "@/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StatusLegend } from "@/components/TaskCard";
import { DependencyGraph } from "@/components/modules/DependencyGraph";
import { IndependentCards } from "@/components/modules/IndependentCards";
import { ModuleCard } from "@/components/modules/ModuleCard";
import { ModuleHeader } from "@/components/modules/ModuleHeader";
import { ModuleRail } from "@/components/modules/ModuleRail";
import { useReadOnlyData } from "@/lib/use-read-only-data";
import { LoadState } from "@/components/NawabanUI";
import { fetchModules, type Project } from "@/lib/api";
import type { ModuleTask } from "@/lib/types";

// Preserve the embedded module view graph algorithm from board_view.py.

import { groupByEpic, buildIndex, layers } from "@/lib/modules-model";
function matches(t: ModuleTask, q: string) {
  const s = q.toLowerCase();
  return (
    t.i.toLowerCase().includes(s) ||
    t.t.toLowerCase().includes(s) ||
    t.e.toLowerCase().includes(s)
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
  useLocale();
  const loadModules = useCallback(() => fetchModules(project), [project]);
  const { data, error } = useReadOnlyData(loadModules);
  const [selected, setSelected] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("epic"),
  );
  const [focusMode, setFocusMode] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);

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

  if (error) return <LoadState error>{error}</LoadState>;
  if (!data || !idx) return <LoadState>{tr("loadingModules")}</LoadState>;
  if (data.unavailable)
    return (
      <p className="p-4 text-body-regular text-text-secondary">
        {tr("modulesUnavailable")}
      </p>
    );

  const cardOnClick = (id: string) => {
    if (focusMode) setFocusId((cur) => (cur === id ? null : id));
    else onSelectTask(id);
  };
  const dimOf = (t: ModuleTask) =>
    focusSet ? !focusSet.has(t.i) : q ? !matches(t, q) : false;
  const hotOf = (t: ModuleTask) => focusSet != null && t.i === focusId;
  const card = (t: ModuleTask) => (
    <ModuleCard
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
  );

  return (
    <div className="modules-layout">
      <ModuleRail
        epics={epics}
        current={current?.epic}
        onSelect={(epic) => {
          setSelected(epic);
          setFocusId(null);
        }}
      />

      <div className="module-graph-scroll">
        {current ? (
          <div className="flex flex-col gap-4 px-6 py-5">
            <ModuleHeader
              group={current}
              stageOf={stageOf}
              stages={cols.length}
              focusMode={focusMode}
              onFocusModeChange={(checked) => {
                setFocusMode(checked);
                setFocusId(null);
              }}
            />

            <StatusLegend available={data.liveness?.available} />

            <DependencyGraph cols={cols} deps={data.deps} focusSet={focusSet} card={card} />

            {loose.length > 0 && <IndependentCards loose={loose} card={card} />}
          </div>
        ) : (
          <p className="p-4 text-body-regular text-text-secondary">
            {tr("noModules")}
          </p>
        )}
      </div>
    </div>
  );
}
