import { t as tr, useLocale } from "@/i18n";
import { Md } from "@/components/Md";
import { H } from "@/components/task-detail/parts";

export function Criteria({ criteria, onSelectTask }: {
  criteria: string | null;
  onSelectTask: (id: string) => void;
}) {
  useLocale();
  if (!criteria) return null;
  return (
    <section className="detail-criteria">
      <div>
        <H>{tr("criteria")}</H>
        <Md className="detail-list" text={criteria} onSelectTask={onSelectTask} />
      </div>
    </section>
  );
}
