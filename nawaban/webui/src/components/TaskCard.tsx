import { t as tr, getLocale, useLocale, statusLabel, waitingLabel } from "@/i18n";
import type { ReactNode } from "react";
import { RiStackLine } from "@remixicon/react";
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
  // Most cards have no window signal; an empty circle on every card says nothing.
  if (signal.kind === "unknown") return null;
  const age = signal.kind === "decision" ? null : liveAge(task.live?.age_s);
  const dot = <StatusDot color="green" className={cx("window-status", `signal-${signal.kind}`)} />;
  const trigger = signal.kind === "decision" ? (
    <Button
      variant="ghost"
      className="task-decision"
      onClick={onDecision}
    >
      {waitingLabel("decision")}
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

// Every card in the acceptance column waits for the release; repeating it on each card is noise.
const COLUMN_IMPLIED_WAITING: Record<string, string> = { "staging-verified": "prod" };

function TaskWaiting({ task }: { task: TaskCardData }) {
  if (task.status === "done" || task.status === "cancelled") return null;
  // The decision wait is already the decision button.
  if (!task.waiting_on || task.waiting_on === "decision"
    || task.waiting_on === COLUMN_IMPLIED_WAITING[task.status]) return null;
  return (
    <Chip className="task-attention" variant="caption" color="soft" data-task-attention>
      <OverflowText className="task-tag-label" text={waitingLabel(task.waiting_on)} />
    </Chip>
  );
}

// Last activity date, pinned right. It only changes colour once started work sits still;
// backlog and finished cards sitting still is normal.
function TaskDate({ task }: { task: TaskCardData }) {
  const now = useTaskClock();
  if (task.active_at === undefined) return null;
  const settled = task.status === "open" || task.status === "done" || task.status === "cancelled";
  const stale = settled ? null : taskStaleness(task.active_at, now);
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
  color?: ChipProps["color"];
}) {
  useLocale();
  return (
    <Chip className="task-tag" color={color} variant="caption">
      <OverflowText className="task-tag-label" text={label} />
    </Chip>
  );
}

export function TaskCard({ task, hasAsk, onSelect, onDecision, className, children, fields = [] }: {
  task: TaskCardData;
  hasAsk: boolean;
  onSelect: () => void;
  onDecision: () => void;
  className?: string;
  children?: ReactNode;
  fields?: readonly string[];
}) {
  useLocale();
  const module = task.epic && task.epic !== "n/a" ? task.epic : null;
  const signal = <WindowStatus task={task} hasAsk={hasAsk} onDecision={onDecision} />;
  const decision = taskSignal(task, hasAsk).kind === "decision";
  return (
    <div data-card-id={task.id}>
      <Surface className={cx("task-card", className)}>
        <ContentButton className="task-card-open" onClick={onSelect}
          aria-label={tr("viewTask", { id: task.id, title: task.title })}>
          <OverflowText className="task-title" text={task.title} />
        </ContentButton>
        {!decision && <span className="task-card-corner">{signal}</span>}
        <div className="task-card-footer">
          {fields.includes("module") && <span className="task-module" data-ungrouped={module ? undefined : ""}>
            <RiStackLine aria-hidden="true" />
            <OverflowText className="task-tag-label" text={module ?? tr("ungrouped")} />
          </span>}
          {task.status === "claimed" && !children && <TaskTag label={statusLabel(task.status)} />}
          {children}
          <TaskWaiting task={task} />
          {decision && signal}
          <TaskDate task={task} />
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
        {available === false && <span>{tr("signalsUnavailable")}</span>}
      </div>
  );
}
