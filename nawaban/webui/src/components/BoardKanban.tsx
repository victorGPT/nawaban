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

// 看板四列:进行中 = API 的 claimed + in_progress 合并(用户拍板的展示形态,
// 不是 API 原生的五列)。
const COLS: Col[] = [
  { id: "open", name: "待认领", color: "#8a8a8a", from: ["open"] },
  { id: "in_progress", name: "进行中", color: "#3b82f6", from: ["claimed", "in_progress"] },
  { id: "staging-verified", name: "待验收", color: "#c0392b", from: ["staging-verified"] },
  { id: "done", name: "最近完成", color: "#2e9e5b", from: ["done"] },
];

type KanbanItem = BoardTask & { name: string; column: string };

// 等待状态 → 卡面徽标。API 的 waiting_on 四值全覆盖(之前只认 decision,其余 23 张看着跟没等一样)。
const WAIT: Record<string, string> = { decision: "等拍板", observe: "等观察", external: "等外部", prod: "等上线" };

// 活性档位(board_view._live_of):working/idle/cold/no-window;null = 未知,留白不渲染。
const LIVE: Record<string, { dot: string; label: string }> = {
  working: { dot: "bg-emerald-400", label: "在跑" },
  idle: { dot: "bg-amber-400", label: "窗口闲着" },
  cold: { dot: "bg-zinc-500", label: "窗口早没动静" },
  "no-window": { dot: "bg-zinc-600", label: "找不到窗口" },
};

// 列头活性计数:合并该列 from[] 各源列的 live_tally
function tallyOf(board: BoardResponse, col: Col) {
  const t = { working: 0, idle: 0, gone: 0 };
  for (const c of board.columns) {
    if (!col.from.includes(c.key) || !c.live_tally) continue;
    t.working += c.live_tally.working ?? 0;
    t.idle += c.live_tally.idle ?? 0;
    t.gone += (c.live_tally.cold ?? 0) + (c.live_tally["no-window"] ?? 0);
  }
  return t;
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
  // 拖拽中间态(仅视觉);canonical 数据永远来自最近一次 /api/board 拉取
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

  if (error) return <p className="p-4 text-sm text-destructive">看板加载失败:{error}</p>;
  if (!board) return <p className="p-4 text-sm text-muted-foreground">加载中…</p>;

  return (
    <KanbanProvider<KanbanItem, Col>
      className="h-full px-6 py-4"
      columns={COLS}
      data={visible}
      onDataChange={setItems}
      onDragEnd={(event) => {
        // 拖拽只做视觉:板是只读投影,状态变更走 CLI(cli.py claim/start/…),
        // 不发明绕过库层闸(done 闸/CAS/拍板通道闸)的写路径。
        // 没实际移动(单纯点击)不提示——onDragEnd 在任何 mousedown/up 都会触发。
        if (event.active.id === event.over?.id) return;
        setItems(toItems(board));
        toast("状态变更走 CLI", { description: "看板拖拽仅供预览,不会改变任务状态" });
      }}
    >
      {(col) => (
        <KanbanBoard id={col.id} key={col.id}>
          <KanbanHeader className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span className="inline-block size-2 rounded-full" style={{ background: col.color }} />
              {col.name}
              <span className="font-normal">{counts[col.id] ?? 0}</span>
            </span>
            {col.id === "in_progress" && (counts[col.id] ?? 0) > 0 && (() => {
              const t = tallyOf(board, col);
              return (
                <span className="flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
                  <span className={t.working ? "text-emerald-400" : ""}>
                    {t.working ? `● ${t.working} 在动` : "无窗口在动"}
                  </span>
                  {t.idle > 0 && <span>· {t.idle} 闲着</span>}
                  {t.gone > 0 && <span className="opacity-60">· {t.gone} 窗口已不在</span>}
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
                        <span className="shrink-0 text-xs text-warn-foreground">{WAIT[item.waiting_on]}</span>
                      )}
                    </div>
                    <p className="m-0 text-ui leading-5 font-medium text-fg-secondary">{item.title}</p>
                    {item.column === "in_progress" && (
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {item.live?.tier && LIVE[item.live.tier] && (
                          <span className="flex items-center gap-1">
                            <span className={`inline-block size-1.5 rounded-full ${LIVE[item.live.tier].dot}`} />
                            {LIVE[item.live.tier].label}
                          </span>
                        )}
                        {item.live?.tier && item.live.tier !== "working" && (
                          <span>· {ago(item.active_at)} 没动</span>
                        )}
                      </div>
                    )}
                    {item.column === "in_progress" && item.now && (
                      <p className="m-0 line-clamp-2 text-xs leading-4 text-muted-foreground">{item.now}</p>
                    )}
                    {item.merged_refs?.length ? (
                      <span className="truncate text-[11px] text-warn-foreground" title={item.merged_refs.join(" · ")}>
                        已有 PR {item.merged_refs.join(" · ")} · 状态待人裁定
                      </span>
                    ) : null}
                    {item.dep?.blocked_by?.length ? (
                      <span className="truncate text-[11px] text-warn-foreground">
                        被 {item.dep.blocked_by.join(", ")} 挡
                      </span>
                    ) : null}
                    {/* 不放 owner 头像:owner 是 session 前缀(ac:ee…),同一台电脑的窗口各有各的叫法,
                        卡面上一堆 EE/CB 只添困惑(用户 2026-09-08);详情页里仍看得到 owner */}
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
