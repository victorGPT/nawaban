import { t as tr, statusLabel, useLocale } from "@/i18n";
import { rel } from "@/components/task-detail/format";
import { Attr } from "@/components/task-detail/parts";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { WAIT } from "@/lib/nawaban-model";
import type { TaskDetail } from "@/lib/types";

export function Properties({ d }: { d: TaskDetail }) {
  useLocale();
  const times = [
    tr("createdAt", { time: rel(d.created_at) }),
    d.started_at && tr("startedAt", { time: rel(d.started_at) }),
    d.completed_at && tr("completedAt", { time: rel(d.completed_at) }),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SettingsCard className="detail-attribute-group">
      <h3 className="attribute-heading">{tr("properties")}</h3>
      <Attr
        label={tr("stageLabel")}
        value={
          statusLabel(d.status)
        }
      />
      <Attr
        label={tr("waitingOn")}
        value={
          d.waiting_on ? (
            <span className="text-status-yellow-text">
              {WAIT[d.waiting_on] ?? d.waiting_on}
            </span>
          ) : null
        }
        empty={tr("notWaiting")}
      />
      <Attr label={tr("owner")} mono value={d.owner} empty={tr("noOwner")} />
      <Attr label={tr("epic")} value={d.epic} />
      <Attr label={tr("decisionDocument")} mono value={d.adr} />
      <Attr label={tr("time")} value={times} />
    </SettingsCard>
  );
}
