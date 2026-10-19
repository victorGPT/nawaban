import { t as tr, getLocale, useLocale } from "@/i18n";
import { RiStackLine } from "@remixicon/react";
import { Badge, badgeVariants } from "@/components/ui/badge";
import type { VariantProps } from "class-variance-authority";
import { ContentButton, Surface } from "@/components/NawabanUI";
import { OverflowText } from "@/components/OverflowText";
import { taskStaleness } from "@/lib/task-staleness";
import { useTaskClock } from "@/lib/use-task-clock";
import type { BoardTask } from "@/lib/types";
import { cx } from "@/utils/cx";

export type TaskCardData = Pick<BoardTask, "id" | "title" | "status"> &
  Partial<Pick<BoardTask, "project" | "active_at">>;

// Last activity date, pinned right. It only changes colour once started work sits still;
// backlog and finished cards sitting still is normal.
function TaskDate({ task }: { task: TaskCardData }) {
  const now = useTaskClock();
  if (task.active_at === undefined) return null;
  const stale = task.status === "in_progress" ? taskStaleness(task.active_at, now) : null;
  const idle = stale && tr("taskInactiveDays", { count: stale.days });
  // ponytail: no year; add it when cards older than a year need telling apart
  const label = new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric" })
    .format(task.active_at * 1000);
  return (
    <time className="task-date" dateTime={new Date(task.active_at * 1000).toISOString()}
      data-stale-level={stale?.level} title={idle || undefined} aria-label={idle ? `${label}, ${idle}` : undefined}>
      {label}
    </time>
  );
}

export function TaskTag({ label, color = "soft" }: {
  label: string;
  color?: VariantProps<typeof badgeVariants>["variant"];
}) {
  useLocale();
  return (
    <Badge className="task-tag" variant={color} size="caption">
      <OverflowText className="task-tag-label" text={label} />
    </Badge>
  );
}

export function TaskCard({ task, onSelect, className, fields = [] }: {
  task: TaskCardData;
  onSelect: () => void;
  className?: string;
  fields?: readonly string[];
}) {
  useLocale();
  return (
    <div data-card-id={task.id}>
      <Surface className={cx("task-card", className)}>
        <ContentButton className="task-card-open" onClick={onSelect}
          aria-label={tr("viewTask", { id: task.id, title: task.title })}>
          <OverflowText className="task-title" text={task.title} />
        </ContentButton>
        <div className="task-card-footer">
          {fields.includes("project") && <span className="task-module" data-ungrouped={task.project ? undefined : ""}>
            <RiStackLine aria-hidden="true" />
            <OverflowText className="task-tag-label" text={task.project || tr("noProject")} />
          </span>}
          <TaskDate task={task} />
        </div>
      </Surface>
    </div>
  );
}
