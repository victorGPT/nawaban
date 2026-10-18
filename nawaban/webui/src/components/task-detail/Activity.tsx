import { t as tr, useLocale } from "@/i18n";
import { Clamp } from "@/components/disclosure/Clamp";
import { Fold } from "@/components/disclosure/Fold";
import { rel } from "@/components/task-detail/format";
import { H } from "@/components/task-detail/parts";
import type { TaskEvent } from "@/lib/types";

// Every event of the task, newest first, as the API returns them.
export function Activity({ events }: { events: TaskEvent[] }) {
  useLocale();
  return (
    <section>
      <H n={events.length}>{tr("activity")}</H>
      <div className="flex flex-col gap-3">
        <Fold
          items={events}
          n={5}
          render={(e, i) => (
            <div className="detail-meta" key={i}>
              <div className="min-w-0">
                <span>{e.author}</span>{" "}
                <span className="detail-meta">{e.kind}</span> · {rel(e.at)}
                <Clamp text={e.body} />
              </div>
            </div>
          )}
        />
      </div>
    </section>
  );
}
