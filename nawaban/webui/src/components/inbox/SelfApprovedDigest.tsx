import { t, useLocale } from "@/i18n";
import { useState } from "react";
import { ContentButton, Surface, useNotice } from "@/components/NawabanUI";
import { Button } from "@/components/ui/button";
import { ago } from "@/lib/utils";
import type { SelfApproved } from "@/lib/types";

function copyReopen(id: string, notice: ReturnType<typeof useNotice>) {
  const cmd = `nawaban reopen ${id} --reason "..."`;
  navigator.clipboard
    .writeText(cmd)
    .then(() => notice(t("copied"), "success", cmd))
    .catch(() => notice(t("copyFailed"), "error"));
}

function SelfApprovedRow({ r }: { r: SelfApproved }) {
  useLocale();
  const notice = useNotice();
  return (
    <Surface className="inbox-history-row min-w-0 text-body-regular">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-text-secondary">{r.id}</span>
        <span className="shrink-0 text-text-secondary">
          {t("elapsedAgo", { time: ago(r.completed_at) })}
        </span>
      </div>
      <p className="break-words text-text-primary">{r.title}</p>
      {r.evidence && (
        <p className="break-words text-text-secondary">
          {r.evidence.slice(0, 160)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <code className="break-all text-body-regular">
          nawaban reopen {r.id} --reason "..."
        </code>
        <Button
          className="detail-action"
          onClick={() => copyReopen(r.id, notice)}
          variant="link-muted"
          size="link"
        >
          {t("copyCommand")}
        </Button>
      </div>
    </Surface>
  );
}

export function SelfApprovedDigest({ items }: { items: SelfApproved[] }) {
  useLocale();
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const lane = items.filter((r) => r.self_evident);
  const silent = items.length - lane.length;
  return (
    <Surface className="inbox-summary">
      <ContentButton
        className="inbox-summary-toggle text-body-regular"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-body-medium">
          {t("selfApprovedTitle", { count: items.length })}
        </span>
        <span className="text-body-regular text-text-secondary">
          {t("selfApprovedCounts", { count: lane.length, other: silent ? t("otherTaskCount", { count: silent }) : "" })}
        </span>
      </ContentButton>
      {expanded && (
        <>
          <div className="mt-2 flex min-w-0 flex-col gap-1.5">
            {lane.map((r) => (
              <SelfApprovedRow key={r.id} r={r} />
            ))}
          </div>
          {silent > 0 && (
            <p className="mt-2 text-body-regular text-text-secondary">
              {t("selfApprovedRemainder", { count: silent })}
            </p>
          )}
        </>
      )}
    </Surface>
  );
}
