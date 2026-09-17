import type { ReactNode } from "react";
import { Button } from "@/components/base/buttons/button";
import { Chip, type ChipProps } from "@/components/base/badges/chip";
import { StatusDot } from "@/components/base/badges/status-dot";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { ContentButton, Surface } from "@/components/NawabanUI";
import { OverflowText } from "@/components/OverflowText";
import { liveAge, taskSignal } from "@/lib/nawaban-model";
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
export type TaskCardData = Pick<BoardTask, "id" | "title" | "epic" | "status" | "live" | "waiting_on">;

export function TaskTag({ label, color = "soft" }: {
  label: string;
  color?: ChipProps["color"];
}) {
  return (
    <Chip className="task-tag" color={color} variant="caption">
      <OverflowText className="task-tag-label" text={label} />
    </Chip>
  );
}

export function TaskCard({ task, hasAsk, onSelect, onDecision, className, children }: {
  task: TaskCardData;
  hasAsk: boolean;
  onSelect: () => void;
  onDecision: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div data-card-id={task.id}>
      <Surface className={cx("task-card", className)}>
        <ContentButton className="task-card-open" onClick={onSelect}
          aria-label={`查看 ${task.id} ${task.title}`}>
          <span className="task-meta">
            <OverflowText as="code" text={task.id} />
            <TaskTag label={task.epic || "未分组"} />
          </span>
          <OverflowText className="task-title text-body-regular" text={task.title} />
        </ContentButton>
        <WindowStatus task={task} hasAsk={hasAsk} onDecision={onDecision} />
        {children && <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div>}
      </Surface>
    </div>
  );
}

export function StatusLegend({ available }: { available?: boolean }) {
  return (
      <div className="status-legend text-body-regular" aria-label="状态图例">
        <span className="text-text-primary">卡片右上角的灯：</span>
        <span>
          <StatusDot color="green" />
          正在工作
        </span>
        <span>
          <StatusDot className="signal-idle" />
          窗口空闲
        </span>
        <span>
          <StatusDot className="signal-unresponsive" />
          窗口无响应
        </span>
        <span>
          <StatusDot color="yellow" />
          需要决策，点击去收件箱
        </span>
        <span>
          <StatusDot className="signal-unknown" />
          状态未知
        </span>
        {available === false && <span>窗口信号当前不可用</span>}
      </div>
  );
}
