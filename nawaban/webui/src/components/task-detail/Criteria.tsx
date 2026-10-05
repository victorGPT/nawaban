import { t as tr, useLocale } from "@/i18n";
import { Bullets, H } from "@/components/task-detail/parts";
import { textItems } from "@/lib/nawaban-model";
import type { TaskDetail } from "@/lib/types";

export function Criteria({ d }: { d: TaskDetail }) {
  useLocale();
  const success = textItems(d.success);
  const constraints = textItems(d.constraints);
  return success.length || constraints.length ? (
    <section className="detail-criteria">
      {success.length > 0 && (
        <div>
          <H n={success.length}>{tr("criteria")}</H>
          <Bullets items={success} />
        </div>
      )}
      {constraints.length > 0 && (
        <div>
          <H n={constraints.length}>{tr("constraints")}</H>
          <Bullets items={constraints} />
        </div>
      )}
    </section>
  ) : null;
}
