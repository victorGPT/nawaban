import { t as tr, useLocale } from "@/i18n";
import { CaptureSource } from "@/components/CaptureSource";
import { H } from "@/components/task-detail/parts";
import type { TaskDetail } from "@/lib/types";

export function CaptureOrigin({ captures }: { captures: TaskDetail["captures"] }) {
  useLocale();
  if (!captures?.length) return null;
  return (
    <section>
      <H>{tr("captureOrigin")}</H>
      <div className="flex flex-col gap-4">{captures.map((item) => <CaptureSource key={item.id} item={item} />)}</div>
    </section>
  );
}
