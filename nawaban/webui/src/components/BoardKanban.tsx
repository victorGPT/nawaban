import { UNGROUPED_EPIC } from "@/lib/modules-model";
import { t as tr, useLocale, statusLabel } from "@/i18n";
import { Fragment, useCallback, useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { RiLayoutColumnLine, RiListCheck, RiRefreshLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Badge } from "@/components/base/badges/badge";
import {
  Table,
  TableHeader,
  TableColumn,
  TableBody,
  TableRow,
  TableCell,
  TableEmpty,
} from "@/components/base/table/table";
import { BoardOptions } from "@/components/BoardOptions";
import { BOARD_DISPLAY_STORAGE, readBoardDisplay, writeBoardDisplay, sortBoardTasks } from "@/lib/board-display";
import { LoadState } from "@/components/NawabanUI";
import { OverflowText } from "@/components/OverflowText";
import { fetchBoard, type DateRange, type Project } from "@/lib/api";
import { boardItems, BOARD_COLUMNS } from "@/lib/nawaban-model";
import { TaskCard, TaskTag, WindowStatus, StatusLegend } from "@/components/TaskCard";
import { useReadOnlyData } from "@/lib/use-read-only-data";
import { TASK_REFRESH_MS } from "@/lib/poll-read-only";
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
  const showId = display.fields.includes("id");
  const showModule = display.fields.includes("module");
  const tableColumns = 2 + Number(showId) + Number(showModule);
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
      <div className="board-toolbar">
        <div className="view-toggle">
          <Button
            size="small"
            variant={layout === "board" ? "secondary" : "ghost"}
            className={
              layout !== "board"
                ? "bg-transparent text-text-secondary"
                : undefined
            }
            leadingIcon={RiLayoutColumnLine}
            aria-pressed={layout === "board"}
            onClick={() => changeLayout("board")}
          >{tr("board")}</Button>
          <Button
            size="small"
            variant={layout === "list" ? "secondary" : "ghost"}
            className={
              layout !== "list"
                ? "bg-transparent text-text-secondary"
                : undefined
            }
            leadingIcon={RiListCheck}
            aria-pressed={layout === "list"}
            onClick={() => changeLayout("list")}
          >{tr("list")}</Button>
        </div>
        <Button variant="secondary" size="small" iconOnly leadingIcon={RiRefreshLine}
          aria-label={tr("refreshTasks")} title={tr("refreshTasks")}
          disabled={refreshing} onClick={refresh} />
        {controls}
        <BoardOptions modules={modules} module={module} onModuleChange={setModule}
          waiting={waiting} onWaitingChange={setWaiting} dateFilters={filters} dateActive={!!range}
          display={display} onDisplayChange={setDisplay} />
      </div>
      <div className="board-source-line text-caption-1-regular">
        <span className="board-source-scope" role="status">
          {project === null ? tr("allProjects") : project || tr("noProject")} / {module === "all" ? tr("allEpics") : module === UNGROUPED_EPIC ? tr("ungrouped") : module}
          {" · "}{board ? tr("taskCount", { count: visible.length }) : error && !refreshing ? tr("boardSyncFailed") : tr("loadingTasks")}
        </span>
        <span className="board-sync-time">
          {refreshing ? tr("syncingTasks") : error ? tr("boardSyncFailed") : updatedAt && tr("syncedAt", { time: updatedAt.toLocaleTimeString(locale, { hour12: false }) })}
          {" · "}{tr("refreshEvery", { seconds: TASK_REFRESH_MS / 1000 })}
        </span>
      </div>
      {layout === "board" && columns.length < BOARD_COLUMNS.length &&
        <p className="px-5 py-2 text-caption-1-regular text-text-secondary">{tr("boardHiddenColumns", { count: BOARD_COLUMNS.length - columns.length })}</p>}
      <div className="board-scroll">
      {error ? <LoadState error>{error}</LoadState> : !board ? <LoadState>{tr("loadingTasks")}</LoadState> : layout === "list" ? (
        <Table
          size="sm"
          aria-label={tr("taskList")}
          className="task-table"
        >
          <colgroup><col className="task-col-title" />{showId && <col className="task-col-id" />}{showModule && <col className="task-col-module" />}<col className="task-col-status" /></colgroup>
          <TableHeader className="sr-only">
            <TableColumn>{tr("taskTitle")}</TableColumn>
            {showId && <TableColumn>{tr("taskId")}</TableColumn>}
            {showModule && <TableColumn>{tr("epicName")}</TableColumn>}
            <TableColumn>{tr("status")}</TableColumn>
          </TableHeader>
          <TableBody>
            {BOARD_COLUMNS.map((column) => {
              const group = visible.filter((task) => column.states.some((state) => state === task.column));
              return <Fragment key={column.id}>
                <tr className="task-list-group" data-stage={column.id}>
                  <th colSpan={tableColumns} scope="rowgroup">
                    <h2 className="text-body-medium"><span className="column-status" aria-hidden="true" />{column.label}<Badge>{group.length}</Badge></h2>
                  </th>
                </tr>
                {group.length === 0 && <TableEmpty colSpan={tableColumns}>{tr("noMatchingTasks")}</TableEmpty>}
                {group.map((task) => (
                  <TableRow key={task.id} aria-label={`${task.id} ${task.title}`} onAction={() => onSelectTask(task.id)}>
                    <TableCell><OverflowText className="task-list-title" text={task.title} />
                      {task.status === "claimed" && <TaskTag label={statusLabel(task.status)} />}
                    </TableCell>
                    {showId && <TableCell><OverflowText as="code" className="task-id" text={task.id} /></TableCell>}
                    {showModule && <TableCell>{task.epic && <TaskTag label={task.epic} />}</TableCell>}
                    <TableCell><WindowStatus task={task} hasAsk={decisionTasks.has(task.id)} onDecision={() => onDecision(task.id)} /></TableCell>
                  </TableRow>
                ))}
              </Fragment>;
            })}
          </TableBody>
        </Table>
      ) : columns.length === 0 ? (
        <div className="flex flex-col items-center gap-3 p-8 text-text-secondary">
          <p>{tr("boardNoColumns")}</p>
          <Button variant="secondary" size="small" onClick={() => setDisplay({ ...display,
            columns: BOARD_COLUMNS.map((column) => column.id) })}>{tr("boardShowAllColumns")}</Button>
        </div>
      ) : (
        <div className="kanban" style={{ "--board-column-count": columns.length } as CSSProperties}>
          {columns.map((s) => (
            <section className="board-column" key={s.id} data-stage={s.id}>
              <h2 className="text-body-medium">
                <span className="column-status" aria-hidden="true" />
                {s.label}
                <Badge>{visible.filter((t) => s.states.some((state) => state === t.column)).length}</Badge>
              </h2>
              <div className="task-stack">
                {!visible.some((t) => s.states.some((state) => state === t.column)) &&
                  <p className="column-empty text-caption-1-regular">{tr("noMatchingTasks")}</p>}
                {visible
                  .filter((t) => s.states.some((state) => state === t.column))
                  .map((t) => (
                    <TaskCard key={t.id} task={t} fields={display.fields} hasAsk={decisionTasks.has(t.id)}
                      onSelect={() => onSelectTask(t.id)} onDecision={() => onDecision(t.id)} />
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
      </div>
      <StatusLegend available={board?.liveness.available} />
    </div>
  );
}
