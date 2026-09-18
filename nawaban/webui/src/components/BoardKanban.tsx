import { UNGROUPED_EPIC } from "@/lib/modules-model";
import { t as tr, useLocale, statusLabel, waitingLabel } from "@/i18n";
import { Fragment, useCallback, useState, type ReactNode } from "react";
import { RiLayoutColumnLine, RiListCheck, RiRefreshLine, RiFilter3Line, RiLayoutRightLine } from "@remixicon/react";
import { Button, buttonStyles } from "@/components/base/buttons/button";
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
import { ModuleSelect } from "@/components/base/select/module-select";
import { LoadState } from "@/components/NawabanUI";
import { OverflowText } from "@/components/OverflowText";
import { fetchBoard, type DateRange, type Project } from "@/lib/api";
import { boardItems, BOARD_COLUMNS } from "@/lib/nawaban-model";
import { TaskCard, TaskTag, WindowStatus, StatusLegend } from "@/components/TaskCard";
import { useReadOnlyData } from "@/lib/use-read-only-data";
import { TASK_REFRESH_MS } from "@/lib/poll-read-only";
import { Dropdown, DropdownTrigger, DropdownPopover, DropdownItem } from "@/components/base/dropdown/dropdown";
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
  const [compact, setCompact] = useState(false);
  const tasks = board ? boardItems(board) : [];
  const modules = [...new Set(tasks.map((t) => t.epic || UNGROUPED_EPIC))].sort();
  const q = query.trim().toLowerCase();
  const visible = tasks.filter(
    (t) =>
      (module === "all" || (t.epic || UNGROUPED_EPIC) === module) &&
      (!waiting || t.waiting_on === waiting) &&
      [t.id, t.title, t.owner ?? "", t.epic ?? ""].some((s) =>
        s.toLowerCase().includes(q),
      ),
  );
  const changeLayout = (value: string) => {
    setLayout(value);
    const url = new URL(location.href);
    url.searchParams.set("layout", value);
    history.replaceState(null, "", url);
  };
  return (
    <div className={cx("board-view", compact && "board-compact")}>
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
        <Dropdown>
          <DropdownTrigger className={cx(buttonStyles.base, buttonStyles.size.small,
            buttonStyles.variant.secondary, buttonStyles.iconOnlySize.small, waiting && "board-tool-active")}
            aria-label={tr("filterWaiting")} title={tr("filterWaiting")}>
            <RiFilter3Line className={buttonStyles.icon.small} aria-hidden />
          </DropdownTrigger>
          <DropdownPopover aria-label={tr("filterWaiting")}>
            {["", "decision", "prod", "observe", "external"].map((value) =>
              <DropdownItem key={value} selected={waiting === value} onSelect={() => setWaiting(value)}>
                {value ? waitingLabel(value) : tr("allWaiting")}
              </DropdownItem>)}
          </DropdownPopover>
        </Dropdown>
        <ModuleSelect modules={modules} value={module} onValueChange={setModule}
          getLabel={(value) => value === UNGROUPED_EPIC ? tr("ungrouped") : value} />
        <Button variant="secondary" size="small" iconOnly leadingIcon={RiLayoutRightLine}
          className={cx(compact && "board-tool-active")}
          aria-label={tr("toggleCompact")} title={tr("toggleCompact")}
          aria-pressed={compact} onClick={() => setCompact(!compact)} />
      </div>
      {filters}
      <div className="board-source-line text-caption-1-regular">
        <span className="board-source-scope" role="status">
          {project === null ? tr("allProjects") : project || tr("noProject")} / {module === "all" ? tr("allEpics") : module === UNGROUPED_EPIC ? tr("ungrouped") : module}
          {" · "}{board ? tr("taskCount", { count: visible.length }) : tr("loadingTasks")}
        </span>
        <span className="board-sync-time">
          {refreshing ? tr("syncingTasks") : error ? tr("boardSyncFailed") : updatedAt && tr("syncedAt", { time: updatedAt.toLocaleTimeString(locale, { hour12: false }) })}
          {" · "}{tr("refreshEvery", { seconds: TASK_REFRESH_MS / 1000 })}
        </span>
      </div>
      <div className="board-scroll">
      {error ? <LoadState error>{error}</LoadState> : !board ? <LoadState>{tr("loadingTasks")}</LoadState> : layout === "list" ? (
        <Table
          size="sm"
          aria-label={tr("taskList")}
          className="task-table"
        >
          <colgroup><col /><col /><col /><col /></colgroup>
          <TableHeader className="sr-only">
            <TableColumn>{tr("taskTitle")}</TableColumn>
            <TableColumn>{tr("taskId")}</TableColumn>
            <TableColumn>{tr("epicName")}</TableColumn>
            <TableColumn>{tr("status")}</TableColumn>
          </TableHeader>
          <TableBody>
            {BOARD_COLUMNS.map((column) => {
              const group = visible.filter((task) => column.states.some((state) => state === task.column));
              return <Fragment key={column.id}>
                <tr className="task-list-group" data-stage={column.id}>
                  <th colSpan={4} scope="rowgroup">
                    <h2 className="text-body-medium"><span className="column-status" aria-hidden="true" />{column.label}<Badge>{group.length}</Badge></h2>
                  </th>
                </tr>
                {group.length === 0 && <TableEmpty colSpan={4}>{tr("noMatchingTasks")}</TableEmpty>}
                {group.map((task) => (
                  <TableRow key={task.id} aria-label={`${task.id} ${task.title}`} onAction={() => onSelectTask(task.id)}>
                    <TableCell><OverflowText className="task-list-title" text={task.title} /></TableCell>
                    <TableCell><OverflowText as="code" className="task-id" text={task.id} /></TableCell>
                    <TableCell><TaskTag label={task.epic || tr("ungrouped")} />
                      {task.status === "claimed" && <TaskTag label={statusLabel(task.status)} />}
                    </TableCell>
                    <TableCell><WindowStatus task={task} hasAsk={decisionTasks.has(task.id)} onDecision={() => onDecision(task.id)} /></TableCell>
                  </TableRow>
                ))}
              </Fragment>;
            })}
          </TableBody>
        </Table>
      ) : (
        <div className="kanban">
          {BOARD_COLUMNS.map((s) => (
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
                    <TaskCard key={t.id} task={t} hasAsk={decisionTasks.has(t.id)}
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
