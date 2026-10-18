import { t as tr, statusLabel, useLocale } from "@/i18n";
import { rel } from "@/components/task-detail/format";
import { Attr, IdLink, Ids } from "@/components/task-detail/parts";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import type { TaskDetail } from "@/lib/types";

export function Properties({ d, onSelectTask }: {
  d: TaskDetail;
  onSelectTask: (id: string) => void;
}) {
  useLocale();
  return (
    <SettingsCard className="detail-attribute-group">
      <h3 className="attribute-heading">{tr("properties")}</h3>
      <Attr label={tr("status")} value={statusLabel(d.status)} />
      <Attr label={tr("project")} value={d.project} empty={tr("noProject")} />
      <Attr label={tr("splitFrom")}
        value={d.parent ? <IdLink id={d.parent.id} onSelect={onSelectTask} /> : null} />
      {d.children.length > 0 && <Attr label={tr("splitOut")}
        value={<Ids ids={d.children.map((c) => c.id)} onSelect={onSelectTask} />} />}
      <Attr label={tr("session")} mono value={d.session} empty={tr("noOwner")} />
      <Attr label={tr("time")} value={tr("createdAt", { time: rel(d.created_at) })} />
    </SettingsCard>
  );
}
