import { t as tr, statusLabel, useLocale } from "@/i18n";
import { H, IdLink } from "@/components/task-detail/parts";
import type { TaskRef } from "@/lib/types";

function TaskRows({ label, tasks, onSelectTask }: {
  label: string;
  tasks: TaskRef[];
  onSelectTask: (id: string) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <H n={tasks.length}>{label}</H>
      <div className="flex flex-col divide-y">
        {tasks.map((t) => (
          <div className="flex flex-col gap-1 py-2 detail-body" key={t.id}>
            <span className="flex items-center gap-2">
              <IdLink id={t.id} onSelect={onSelectTask} />
              <span className="detail-meta">{statusLabel(t.status)}</span>
            </span>
            <p className="detail-body">{t.title}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Dependencies({ blockedBy, dependents, onSelectTask }: {
  blockedBy: TaskRef[];
  dependents: TaskRef[];
  onSelectTask: (id: string) => void;
}) {
  useLocale();
  return (
    <>
      <TaskRows label={tr("blockedBy")} tasks={blockedBy} onSelectTask={onSelectTask} />
      <TaskRows label={tr("dependents")} tasks={dependents} onSelectTask={onSelectTask} />
    </>
  );
}
