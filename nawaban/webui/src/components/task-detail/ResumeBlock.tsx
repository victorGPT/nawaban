import { t as tr, useLocale } from "@/i18n";
import { RiTerminalBoxLine as TerminalSquare } from "@remixicon/react";
import { CopyBtn } from "@/components/disclosure/CopyBtn";

export function ResumeBlock({ session }: { session: string }) {
  useLocale();
  return (
    <div className="detail-resume flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5 detail-meta">
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="truncate">
          {session} · {tr("inProgress")}
        </span>
      </span>
      <CopyBtn label="resume" text={`claude --resume ${session}`} />
    </div>
  );
}
