import { t as tr, useLocale } from "@/i18n";
import { TaskContext } from "@/components/TaskContext";
import { H } from "@/components/task-detail/parts";
import type { TaskDetail } from "@/lib/types";

export function ContextSection({
  d,
  onSelectTask,
}: {
  d: TaskDetail;
  onSelectTask: (id: string) => void;
}) {
  useLocale();
  if (!d.context || d.context === d.now) return null;
  return (
    <section>
      <H>{tr("context")}</H>
      <TaskContext
        key={d.id}
        context={d.context}
        decisions={d.decisions}
        onSelectTask={onSelectTask}
      />
    </section>
  );
}
