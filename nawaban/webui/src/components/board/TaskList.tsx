import { t as tr, useLocale, statusLabel } from "@/i18n";
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { ActionRow } from "@/components/application/table/action-row";
import { OverflowText } from "@/components/OverflowText";
import { TaskTag, WindowStatus } from "@/components/TaskCard";
import { BOARD_COLUMNS } from "@/lib/nawaban-model";
import type { BoardTask } from "@/lib/types";

export function TaskList({
  tasks,
  fields,
  decisionTasks,
  onSelectTask,
  onDecision,
}: {
  tasks: (BoardTask & { column: string })[];
  fields: readonly string[];
  decisionTasks: Set<string>;
  onSelectTask: (id: string) => void;
  onDecision: (id: string) => void;
}) {
  useLocale();
  const showId = fields.includes("id");
  const showModule = fields.includes("module");
  const tableColumns = 2 + Number(showId) + Number(showModule);
  return (
    <Table
      aria-label={tr("taskList")}
      className="bui-table bui-table-sm task-table"
    >
      <colgroup><col className="task-col-title" />{showId && <col className="task-col-id" />}{showModule && <col className="task-col-module" />}<col className="task-col-status" /></colgroup>
      <TableHeader className="sr-only">
        <TableRow>
          <TableHead>{tr("taskTitle")}</TableHead>
          {showId && <TableHead>{tr("taskId")}</TableHead>}
          {showModule && <TableHead>{tr("epicName")}</TableHead>}
          <TableHead>{tr("status")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {BOARD_COLUMNS.map((column) => {
          const group = tasks.filter((task) => column.states.some((state) => state === task.column));
          return <Fragment key={column.id}>
            <tr className="task-list-group" data-stage={column.id}>
              <th colSpan={tableColumns} scope="rowgroup">
                <h2 className="text-body-medium"><span className="column-status" aria-hidden="true" />{column.label}<Badge variant="count" size="count">{group.length}</Badge></h2>
              </th>
            </tr>
            {group.length === 0 && <TableRow><TableCell colSpan={tableColumns}>{tr("noMatchingTasks")}</TableCell></TableRow>}
            {group.map((task) => (
              <ActionRow key={task.id} aria-label={`${task.id} ${task.title}`} onAction={() => onSelectTask(task.id)}>
                <TableCell><OverflowText className="task-list-title" text={task.title} />
                  {task.status === "claimed" && <TaskTag label={statusLabel(task.status)} />}
                </TableCell>
                {showId && <TableCell><OverflowText as="code" className="task-id" text={task.id} /></TableCell>}
                {showModule && <TableCell>{task.epic && <TaskTag label={task.epic} />}</TableCell>}
                <TableCell><WindowStatus task={task} hasAsk={decisionTasks.has(task.id)} onDecision={() => onDecision(task.id)} /></TableCell>
              </ActionRow>
            ))}
          </Fragment>;
        })}
      </TableBody>
    </Table>
  );
}
