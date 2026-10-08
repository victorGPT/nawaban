import { UNGROUPED_EPIC } from "@/lib/modules-model";
import { t as tr, useLocale } from "@/i18n";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BoardOptions } from "@/components/BoardOptions";
import { BoardSourceLine } from "@/components/board/BoardSourceLine";
import { BoardToolbar } from "@/components/board/BoardToolbar";
import { KanbanColumns } from "@/components/board/KanbanColumns";
import { TaskList } from "@/components/board/TaskList";
import { BOARD_DISPLAY_STORAGE, readBoardDisplay, writeBoardDisplay, sortBoardTasks } from "@/lib/board-display";
import { LoadState } from "@/components/NawabanUI";
import { fetchBoard, type DateRange, type Project } from "@/lib/api";
import { boardItems, BOARD_COLUMNS } from "@/lib/nawaban-model";
import { StatusLegend } from "@/components/TaskCard";
import { useReadOnlyData } from "@/lib/use-read-only-data";
import { cx } from "@/utils/cx";

export function BoardKanban({
  controls,
  filters,
  query,
  range,
  project,
  onSelectTask,
  onDecision,
  decisionTasks,
}: {
  controls?: ReactNode;
  filters?: ReactNode;
  query: string;
  range: DateRange | null;
  project: Project;
  onSelectTask: (id: string) => void;
  onDecision: (id: string) => void;
  decisionTasks: Set<string>;
}) {
  const locale = useLocale();
  const loadBoard = useCallback(() => fetchBoard(range, project), [range, project]);
  const { data: board, error, updatedAt, refreshing, refresh } = useReadOnlyData(loadBoard);
  const [layout, setLayout] = useState(() =>
    new URLSearchParams(location.search).get("layout") === "list"
      ? "list"
      : "board",
  );
  const [module, setModule] = useState("all");
  const [waiting, setWaiting] = useState("");
  const [display, setDisplay] = useState(() => {
    let saved: string | null = null;
    // Browser privacy settings may deny local storage; URL preferences still work.
    try { saved = localStorage.getItem(BOARD_DISPLAY_STORAGE); } catch { /* URL only. */ }
    return readBoardDisplay(location.search, saved);
  });
  useEffect(() => {
    const url = new URL(location.href);
    writeBoardDisplay(url.searchParams, display);
    history.replaceState(null, "", url);
    try { localStorage.setItem(BOARD_DISPLAY_STORAGE, writeBoardDisplay(new URLSearchParams(), display).toString()); }
    catch { /* The URL remains shareable when local storage is unavailable. */ }
  }, [display]);
  const columns = BOARD_COLUMNS.filter((column) => display.columns.includes(column.id));
  const tasks = board ? boardItems(board) : [];
  const modules = [...new Set(tasks.map((t) => t.epic || UNGROUPED_EPIC))].sort();
  const q = query.trim().toLowerCase();
  const visible = sortBoardTasks(tasks.filter(
    (t) =>
      (module === "all" || (t.epic || UNGROUPED_EPIC) === module) &&
      (!waiting || t.waiting_on === waiting) &&
      [t.id, t.title, t.owner ?? "", t.epic ?? ""].some((s) =>
        s.toLowerCase().includes(q),
      ),
  ), display.sort, locale);
  const changeLayout = (value: string) => {
    setLayout(value);
    const url = new URL(location.href);
    url.searchParams.set("layout", value);
    history.replaceState(null, "", url);
  };
  return (
    <div className={cx("board-view", display.compact && "board-compact")}>
      <BoardToolbar layout={layout} onLayoutChange={changeLayout} refreshing={refreshing} onRefresh={refresh}>
        {controls}
        <BoardOptions modules={modules} module={module} onModuleChange={setModule}
          waiting={waiting} onWaitingChange={setWaiting} dateFilters={filters} dateActive={!!range}
          display={display} onDisplayChange={setDisplay} />
      </BoardToolbar>
      <BoardSourceLine project={project} module={module} count={board ? visible.length : null}
        error={error} refreshing={refreshing} updatedAt={updatedAt} />
      {layout === "board" && columns.length < BOARD_COLUMNS.length &&
        <p className="px-5 py-2 text-caption-1-regular text-text-secondary">{tr("boardHiddenColumns", { count: BOARD_COLUMNS.length - columns.length })}</p>}
      <div className="board-scroll">
      {error ? <LoadState error>{error}</LoadState> : !board ? <LoadState>{tr("loadingTasks")}</LoadState> : layout === "list" ? (
        <TaskList tasks={visible} fields={display.fields} decisionTasks={decisionTasks}
          onSelectTask={onSelectTask} onDecision={onDecision} />
      ) : (
        <KanbanColumns columns={columns} tasks={visible} fields={display.fields} decisionTasks={decisionTasks}
          onSelectTask={onSelectTask} onDecision={onDecision}
          onShowAllColumns={() => setDisplay({ ...display,
            columns: BOARD_COLUMNS.map((column) => column.id) })} />
      )}
      </div>
      <StatusLegend available={board?.liveness.available} />
    </div>
  );
}
