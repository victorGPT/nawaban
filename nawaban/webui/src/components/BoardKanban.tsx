import { useCallback, useState } from "react";
import { RiLayoutColumnLine, RiListCheck } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { Chip } from "@/components/base/badges/chip";
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
import { boardItems, STAGES } from "@/lib/nawaban-model";
import { TaskCard, TaskTag, WindowStatus, StatusLegend } from "@/components/TaskCard";
import { useReadOnlyData } from "@/lib/use-read-only-data";

export function BoardKanban({
  query,
  range,
  project,
  onSelectTask,
  onDecision,
  decisionTasks,
}: {
  query: string;
  range: DateRange | null;
  project: Project;
  onSelectTask: (id: string) => void;
  onDecision: (id: string) => void;
  decisionTasks: Set<string>;
}) {
  const loadBoard = useCallback(() => fetchBoard(range, project), [range, project]);
  const { data: board, error } = useReadOnlyData(loadBoard);
  const [layout, setLayout] = useState(() =>
    new URLSearchParams(location.search).get("layout") === "list"
      ? "list"
      : "board",
  );
  const [module, setModule] = useState("all");
  if (error) return <LoadState error>{error}</LoadState>;
  if (!board) return <LoadState>正在读取任务…</LoadState>;
  const tasks = boardItems(board);
  const modules = [...new Set(tasks.map((t) => t.epic || "未分组"))].sort();
  const q = query.trim().toLowerCase();
  const visible = tasks.filter(
    (t) =>
      (module === "all" || (t.epic || "未分组") === module) &&
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
    <div className="board-view">
      <div className="overview-strip">
        {STAGES.map((s) => (
          <div key={s.id}>
            <Chip
              color={s.id === "staging-verified" ? "yellow" : "soft"}
              variant="caption"
            >
              {s.label}
            </Chip>
            <span className="text-body-medium">
              {tasks.filter((t) => t.column === s.id).length}
            </span>
          </div>
        ))}
      </div>
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
          >
            看板
          </Button>
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
          >
            列表
          </Button>
        </div>
        <ModuleSelect modules={modules} value={module} onValueChange={setModule} />
        <span className="text-body-regular text-text-secondary">
          {visible.length} 项任务
        </span>
      </div>
      <StatusLegend available={board.liveness.available} />
      {layout === "list" ? (
        <Table
          size="sm"
          aria-label="任务列表"
          className="task-table"
        >
          <TableHeader>
            <TableColumn>编号</TableColumn>
            <TableColumn>
              标题
            </TableColumn>
            <TableColumn>模块名</TableColumn>
            <TableColumn>状态</TableColumn>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && <TableEmpty colSpan={4}>没有匹配的任务</TableEmpty>}
            {visible.map((t) => (
              <TableRow key={t.id} aria-label={`${t.id} ${t.title}`} onAction={() => onSelectTask(t.id)}>
                <TableCell>
                  <OverflowText as="code" className="task-id" text={t.id} />
                </TableCell>
                <TableCell>
                  <OverflowText className="task-list-title" text={t.title} />
                </TableCell>
                <TableCell>
                  <TaskTag label={t.epic || "未分组"} />
                </TableCell>
                <TableCell>
                  <WindowStatus
                    task={t}
                    hasAsk={decisionTasks.has(t.id)}
                    onDecision={() => onDecision(t.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="kanban">
          {STAGES.map((s) => (
            <section className="board-column" key={s.id}>
              <h2 className="text-body-medium">
                {s.label}
                <Badge>{visible.filter((t) => t.column === s.id).length}</Badge>
              </h2>
              <div className="task-stack">
                {visible
                  .filter((t) => t.column === s.id)
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
  );
}
