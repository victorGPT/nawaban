import { t as tr, useLocale } from "@/i18n";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TaskCard } from "@/components/TaskCard";
import type { BOARD_COLUMNS } from "@/lib/nawaban-model";
import type { BoardTask } from "@/lib/types";

export function KanbanColumns({
  columns,
  tasks,
  fields,
  onSelectTask,
  onShowAllColumns,
}: {
  columns: readonly (typeof BOARD_COLUMNS)[number][];
  tasks: (BoardTask & { column: string })[];
  fields: readonly string[];
  onSelectTask: (id: string) => void;
  onShowAllColumns: () => void;
}) {
  useLocale();
  if (columns.length === 0)
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-text-secondary">
        <p>{tr("boardNoColumns")}</p>
        <Button variant="outline" onClick={onShowAllColumns}>{tr("boardShowAllColumns")}</Button>
      </div>
    );
  return (
    <div className="kanban" style={{ "--board-column-count": columns.length } as CSSProperties}>
      {columns.map((s) => {
        const group = tasks.filter((t) => s.states.some((state) => state === t.column));
        return (
          <section className="board-column" key={s.id} data-stage={s.id}>
            <h2 className="text-body-medium">
              <span className="column-status" aria-hidden="true" />
              {s.label}
              <Badge variant="count" size="count">{group.length}</Badge>
            </h2>
            <div className="task-stack">
              {group.length === 0 &&
                <p className="column-empty text-caption-1-regular">{tr("noMatchingTasks")}</p>}
              {group.map((t) => (
                <TaskCard key={t.id} task={t} fields={fields} onSelect={() => onSelectTask(t.id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
