import { t, type TranslationKey } from "@/i18n";
// Five display columns map directly to the API lifecycle states.
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
} from "@/components/kibo-ui/kanban";
import { Badge } from "@/components/ui/badge";
import { fetchBoard, type DateRange } from "@/lib/api";
import { ago } from "@/lib/utils";
import type { BoardResponse, BoardTask } from "@/lib/types";

type Col = { id: string; name: string; color: string; from: string[] };

const COLS: (Col & { name: TranslationKey })[] = [
  { id: "open", name: "unassigned", color: "#8a8a8a", from: ["open"] },
  { id: "claimed", name: "assigned", color: "#8a5cf6", from: ["claimed"] },
  { id: "in_progress", name: "inProgress", color: "#3b82f6", from: ["in_progress"] },
  { id: "staging-verified", name: "ready", color: "#c0392b", from: ["staging-verified"] },
  { id: "done", name: "recentDone", color: "#2e9e5b", from: ["done"] },
];

type KanbanItem = BoardTask & { name: string; column: string };

const WAIT: Record<string, TranslationKey> = { decision: "waitDecision", observe: "waitObserve", external: "waitExternal", prod: "waitDeploy" };

const LIVE: Record<string, { dot: string; label: TranslationKey }> = {
  working: { dot: "bg-emerald-400", label: "running" },
  idle: { dot: "bg-amber-400", label: "idleWindow" },
  cold: { dot: "bg-zinc-500", label: "coldWindow" },
  "no-window": { dot: "bg-zinc-600", label: "missingWindow" },
};

function tallyOf(board: BoardResponse, col: Col) {
  const tally = { working: 0, idle: 0, gone: 0 };
  for (const c of board.columns) {
    if (!col.from.includes(c.key) || !c.live_tally) continue;
    tally.working += c.live_tally.working ?? 0;
    tally.idle += c.live_tally.idle ?? 0;
    tally.gone += (c.live_tally.cold ?? 0) + (c.live_tally["no-window"] ?? 0);
  }
  return tally;
}

function toItems(board: BoardResponse): KanbanItem[] {
  const byKey = new Map(board.columns.map((c) => [c.key, c.tasks]));
  const items: KanbanItem[] = [];
  for (const col of COLS) {
    for (const src of col.from) {
      for (const t of byKey.get(src) ?? []) {
        items.push({ ...t, name: t.title, column: col.id });
      }
    }
  }
  return items;
}

function matches(item: KanbanItem, q: string) {
  const s = q.toLowerCase();
  return (
    item.id.toLowerCase().includes(s) ||
    item.title.toLowerCase().includes(s) ||
    (item.owner ?? "").toLowerCase().includes(s) ||
    (item.epic ?? "").toLowerCase().includes(s)
  );
}

export function BoardKanban({
  query,
  range,
  onSelectTask,
}: {
  query: string;
  range: DateRange | null;
  onSelectTask: (id: string) => void;
}) {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState<KanbanItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchBoard(range)
        .then((d) => {
          if (cancelled) return;
          setBoard(d);
          setItems(toItems(d));
          setError(null);
        })
        .catch((e) => !cancelled && setError(String(e)));
    load();
    const iv = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [range]);

  const visible = useMemo(
    () => (query.trim() ? items.filter((it) => matches(it, query.trim())) : items),
    [items, query]
  );

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const it of visible) m[it.column] = (m[it.column] ?? 0) + 1;
    return m;
  }, [visible]);

  if (error) return <p className="p-4 text-sm text-destructive">{t("boardError")}{error}</p>;
  if (!board) return <p className="p-4 text-sm text-muted-foreground">{t("loading")}</p>;

  return (
    <KanbanProvider<KanbanItem, Col>
      className="h-full px-6 py-4"
      columns={COLS.map((col) => ({ ...col, name: t(col.name) }))}
      data={visible}
      onDataChange={setItems}
      onDragEnd={(event) => {

        if (event.active.id === event.over?.id) return;
        setItems(toItems(board));
        toast(t("changeViaCli"), { description: t("dragPreview") });
      }}
    >
      {(col) => (
        <KanbanBoard id={col.id} key={col.id}>
          <KanbanHeader className="flex h-12 flex-col items-start justify-center gap-1">
            <span className="flex items-center gap-2">
              <span className="inline-block size-2 rounded-full" style={{ background: col.color }} />
              {col.name}
              <span className="font-normal">{counts[col.id] ?? 0}</span>
            </span>
            {col.id === "in_progress" && (counts[col.id] ?? 0) > 0 && (() => {
              const tally = tallyOf(board, col);
              return (
                <span className="flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
                  <span className={tally.working ? "text-emerald-400" : ""}>
                    {tally.working ? t("workingCount", { count: tally.working }) : t("noRunning")}
                  </span>
                  {tally.idle > 0 && <span>· {t("idleCount", { count: tally.idle })}</span>}
                  {tally.gone > 0 && <span className="opacity-60">· {t("goneCount", { count: tally.gone })}</span>}
                </span>
              );
            })()}
          </KanbanHeader>
          <KanbanCards id={col.id}>
            {(item: KanbanItem) => {
              return (
                <KanbanCard column={col.id} id={item.id} key={item.id} name={item.name}>
                  <div
                    className="flex flex-col gap-1.5"
                    onClick={() => onSelectTask(item.id)}
                    role="presentation"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {item.id}
                      </span>
                      {item.waiting_on && WAIT[item.waiting_on] && (
                        <span className="shrink-0 text-xs text-warn-foreground">{t(WAIT[item.waiting_on])}</span>
                      )}
                    </div>
                    <p className="m-0 text-ui leading-5 font-medium text-fg-secondary">{item.title}</p>
                    {item.column === "in_progress" && (
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {item.live?.tier && LIVE[item.live.tier] && (
                          <span className="flex items-center gap-1">
                            <span className={`inline-block size-1.5 rounded-full ${LIVE[item.live.tier].dot}`} />
                            {t(LIVE[item.live.tier].label)}
                          </span>
                        )}
                        {item.live?.tier && item.live.tier !== "working" && (
                          <span>· {t("inactiveFor", { time: ago(item.active_at) })}</span>
                        )}
                      </div>
                    )}
                    {item.column === "in_progress" && item.now && (
                      <p className="m-0 line-clamp-2 text-xs leading-4 text-muted-foreground">{item.now}</p>
                    )}
                    {item.merged_refs?.length ? (
                      <span className="truncate text-[11px] text-warn-foreground" title={item.merged_refs.join(" · ")}>
                        {t("existingPr", { refs: item.merged_refs.join(" · ") })}
                      </span>
                    ) : null}
                    {item.dep?.blocked_by?.length ? (
                      <span className="truncate text-[11px] text-warn-foreground">
                        {t("blockedByTasks", { tasks: item.dep.blocked_by.join(", ") })}
                      </span>
                    ) : null}

                    {item.epic && (
                      <Badge className="self-start border-border text-[11px] text-muted-foreground" variant="outline">
                        {item.epic}
                      </Badge>
                    )}
                  </div>
                </KanbanCard>
              );
            }}
          </KanbanCards>
        </KanbanBoard>
      )}
    </KanbanProvider>
  );
}
