import { t as tr, useLocale } from "@/i18n";
import { H, IdLink } from "@/components/task-detail/parts";
import type { KinResponse } from "@/lib/types";

export function Dependencies({
  kin,
  onSelectTask,
}: {
  kin: KinResponse | null;
  onSelectTask: (id: string) => void;
}) {
  useLocale();
  return (
    <>
      {kin && kin.blocked_by.length > 0 && (
        <section>
          <H n={kin.blocked_by.length}>{tr("blockedBy")}</H>
          <p className="mb-2 detail-meta">
            {tr("stuckAt")}
            <IdLink id={kin.stuck_at!} onSelect={onSelectTask} />
          </p>
          <div className="flex flex-col divide-y">
            {kin.blocked_by.map((t) => (
              <div
                className="py-2 detail-body"
                key={t.id}
                style={{ marginLeft: (t.depth - 1) * 12 }}
              >
                <IdLink id={t.id} onSelect={onSelectTask} />
                <span className="ml-2 detail-meta">{t.status}</span>
                <p className="mt-1 detail-body">{t.title}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {kin && kin.unblocks.length > 0 && (
        <section>
          <H n={kin.unblocks.length}>{tr("unblocks")}</H>
          <div className="flex flex-col divide-y">
            {kin.unblocks.map((t) => (
              <div className="py-2 detail-body" key={t.id}>
                <IdLink id={t.id} onSelect={onSelectTask} />
                <span className="ml-2 detail-meta">{t.status}</span>
                <p className="mt-1 detail-body">{t.title}</p>
                {t.others_waiting > 0 && (
                  <p className="detail-meta">
                    {tr("othersWaiting", { count: t.others_waiting })}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
