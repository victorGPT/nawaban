import { t as tr, useLocale } from "@/i18n";
import { RiTerminalBoxLine as TerminalSquare } from "@remixicon/react";
import { CopyBtn } from "@/components/disclosure/CopyBtn";
import type { TaskSession } from "@/lib/types";

export function ResumeBlock({ s }: { s: TaskSession }) {
  useLocale();
  return (
    <div className="detail-resume flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5 detail-meta">
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="truncate">
          {s.owner} · {s.outcome ?? tr("inProgress")}
        </span>
      </span>
      <CopyBtn label="resume" text={`claude --resume ${s.session_id}`} />
    </div>
  );
}
