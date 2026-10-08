import { t, useLocale } from "@/i18n";
import { CaptureSource } from "@/components/CaptureSource";
import { Button } from "@/components/ui/button";
import { Surface } from "@/components/NawabanUI";
import type { Capture } from "@/lib/types";
import { ago } from "@/lib/utils";

export function CaptureCard({ item, onSelectTask }: {
  item: Capture; onSelectTask: (id: string) => void;
}) {
  useLocale();
  return <Surface className="flex flex-col gap-3 p-4">
    <CaptureSource item={item} />
    <div className="flex flex-wrap items-center gap-3 text-caption-1-regular text-text-tertiary">
      <span>{ago(item.created_at)}</span>
      <span>{item.project || t("noProject")}</span>
      <span>{t(item.status === "pending" ? "capturePending" : item.status === "converted" ? "captureConverted" : "captureDiscarded")}</span>
      {item.task_id && <Button variant="link" size="link" onClick={() => onSelectTask(item.task_id!)}>{item.task_id}</Button>}
    </div>
    {item.reason && <p className="whitespace-pre-wrap break-words text-body-regular text-text-secondary">{t("captureReason", { reason: item.reason })}</p>}
  </Surface>;
}
