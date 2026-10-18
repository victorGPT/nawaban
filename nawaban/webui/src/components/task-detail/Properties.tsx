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
      <Attr label={tr("parent")}
        value={d.parent ? <IdLink id={d.parent.id} onSelect={onSelectTask} /> : null} />
      {d.children.length > 0 && <Attr label={tr("children")}
        value={<Ids ids={d.children.map((c) => c.id)} onSelect={onSelectTask} />} />}
      {/* Only an in-progress task has a working session; a closed task's leftover one is stale. */}
      <Attr label={tr("session")} mono value={d.status === "in_progress" ? d.session : null}
        empty={tr("noSession")} />
      <Attr label={tr("time")} value={tr("createdAt", { time: rel(d.created_at) })} />
    </SettingsCard>
  );
}
