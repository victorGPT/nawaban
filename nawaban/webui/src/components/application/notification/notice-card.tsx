import type { ReactNode } from "react";
import {
  RiCheckboxCircleFill,
  RiErrorWarningFill,
  RiInformationFill,
  RiNotification3Fill,
} from "@remixicon/react";
import { cn } from "@/lib/utils";

export type NoticeStatus = "neutral" | "information" | "success" | "error";

const STATUS_ICON = {
  neutral: RiNotification3Fill,
  information: RiInformationFill,
  success: RiCheckboxCircleFill,
  error: RiErrorWarningFill,
};

const STATUS_VISUAL: Record<NoticeStatus, string> = {
  neutral: "bg-background-tertiary-default text-text-secondary",
  information: "bg-notification-information-background text-notification-information-foreground",
  success: "bg-notification-success-background text-notification-success-foreground",
  error: "bg-notification-error-background text-notification-error-foreground",
};

/**
 * App composition: the status card used for load/error states and as the body
 * of a notice toast. shadcn has no notification primitive; this keeps the
 * Figma recipe (icon disc + title + description) and nothing else.
 */
export function NoticeCard({
  title,
  description,
  status = "neutral",
  className,
  ...props
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: NoticeStatus;
  className?: string;
  role?: string;
}) {
  const Icon = STATUS_ICON[status];
  return (
    <div
      role={props.role ?? (status === "error" ? "alert" : "status")}
      className={cn(
        "relative flex w-full items-start gap-3 overflow-hidden rounded-2xl border border-border-button-default bg-background-primary-default p-4 pr-11 shadow-dropdown",
        className,
      )}
      {...props}
    >
      <span className={cn("relative flex size-10 shrink-0 items-center justify-center rounded-full", STATUS_VISUAL[status])}>
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-body-medium text-text-primary">{title}</p>
        {description ? <p className="text-body-regular text-text-secondary">{description}</p> : null}
      </div>
    </div>
  );
}
