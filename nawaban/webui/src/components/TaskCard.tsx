import { t as tr, useLocale, statusLabel, waitingLabel } from "@/i18n";
import type { ReactNode } from "react";
import { Button } from "@/components/base/buttons/button";
import { Chip, type ChipProps } from "@/components/base/badges/chip";
import { StatusDot } from "@/components/base/badges/status-dot";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { ContentButton, Surface } from "@/components/NawabanUI";
import { OverflowText } from "@/components/OverflowText";
import { liveAge, taskSignal } from "@/lib/nawaban-model";
import { taskStaleness } from "@/lib/task-staleness";
import { useTaskClock } from "@/lib/use-task-clock";
import type { BoardTask } from "@/lib/types";
import { cx } from "@/utils/cx";

export function WindowStatus({
  task,
  hasAsk,
  onDecision,
}: {
  task: Pick<BoardTask, "live" | "waiting_on">;
  hasAsk: boolean;
  onDecision?: () => void;
}) {
  useLocale();
  const signal = taskSignal(task, hasAsk);
  const age = signal.kind === "decision" ? null : liveAge(task.live?.age_s);
  const dot = (
    <StatusDot
      color={signal.kind === "decision" ? "yellow" : "green"}
      className={cx("window-status", `signal-${signal.kind}`)}
    />
  );
  const trigger = signal.kind === "decision" && onDecision ? (
    <Button
      variant="ghost"
      className="signal-button"
      aria-label={signal.label}
      onClick={onDecision}
    >
      {dot}
    </Button>
  ) : (
    <span
      className="signal-button"
      role="img"
      tabIndex={0}
      aria-label={age ? `${signal.label}，${age}` : signal.label}
    >
      {dot}
    </span>
  );
  return (
    <TooltipTrigger delay={150}>
      {trigger}
      <Tooltip placement="left">
        <span className="block">{signal.label}</span>
        {age && <span className="block text-text-secondary">{age}</span>}
      </Tooltip>
    </TooltipTrigger>
  );
}
export type TaskCardData = Pick<BoardTask, "id" | "title" | "epic" | "status" | "live" | "waiting_on">
  & { active_at?: number };

function TaskAttention({ task }: { task: TaskCardData }) {
  const now = useTaskClock();
  if (task.status === "done" || task.status === "cancelled") return null;
  const stale = taskStaleness(task.active_at, now);
  if (!stale && !task.waiting_on) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-1" data-task-attention>
      {task.waiting_on && <Chip variant="caption" color="soft">{waitingLabel(task.waiting_on)}</Chip>}
      {stale && <Chip variant="caption" data-stale-level={stale.level}
        color={stale.level === "critical" ? "rose" : stale.level === "warning" ? "yellow" : "soft"}>
        {tr("taskInactiveDays", { count: stale.days })}
      </Chip>}
    </span>
  );
}

export function TaskTag({ label, color = "soft" }: {
  label: string;
  color?: ChipProps["color"];
}) {
  useLocale();
  return (
    <Chip className="task-tag" color={color} variant="caption">
      <OverflowText className="task-tag-label" text={label} />
    </Chip>
  );
}

export function TaskCard({ task, hasAsk, onSelect, onDecision, className, children, fields = ["id"] }: {
  task: TaskCardData;
  hasAsk: boolean;
  onSelect: () => void;
  onDecision: () => void;
  className?: string;
  children?: ReactNode;
  fields?: readonly string[];
}) {
  useLocale();
  return (
    <div data-card-id={task.id}>
      <Surface className={cx("task-card", className)}>
        <ContentButton className="task-card-open" onClick={onSelect}
          aria-label={tr("viewTask", { id: task.id, title: task.title })}>
          <OverflowText className="task-title" text={task.title} />
          <TaskAttention task={task} />
          {fields.includes("id") && <span className="task-meta">
            <OverflowText as="code" text={task.id} />
          </span>}
        </ContentButton>
        <div className="task-card-footer">
          {task.status === "claimed" && !children && <TaskTag label={statusLabel(task.status)} />}
          {fields.includes("module") && <TaskTag label={task.epic || tr("ungrouped")} />}
          {children}
          <WindowStatus task={task} hasAsk={hasAsk} onDecision={onDecision} />
        </div>
      </Surface>
    </div>
  );
}

export function StatusLegend({ available }: { available?: boolean }) {
  useLocale();
  return (
      <div className="status-legend text-body-regular" aria-label={tr("statusLegend")}>
        <span className="text-text-primary">{tr("cardSignalLegend")}</span>
        <span>
          <StatusDot color="green" />{tr("workingSignal")}</span>
        <span>
          <StatusDot className="signal-idle" />{tr("idleSignal")}</span>
        <span>
          <StatusDot className="signal-unresponsive" />{tr("unresponsiveSignal")}</span>
        <span>
          <StatusDot color="yellow" />{tr("decisionSignal")}</span>
        <span>
          <StatusDot className="signal-unknown" />{tr("unknownSignal")}</span>
        {available === false && <span>{tr("signalsUnavailable")}</span>}
      </div>
  );
}
