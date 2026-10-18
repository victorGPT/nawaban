import { t as tr, useLocale } from "@/i18n";
import { Md } from "@/components/Md";
import { rel } from "@/components/task-detail/format";
import { H } from "@/components/task-detail/parts";
import { eventMarkdown } from "@/lib/nawaban-model";
import type { TaskEvent } from "@/lib/types";

// A decision body is free text (question, verdict, rejected options); it is shown as written.
export function Decisions({ decisions }: { decisions: TaskEvent[] }) {
  useLocale();
  if (decisions.length === 0) return null;
  return (
    <section>
      <H n={decisions.length}>{tr("decisions")}</H>
      <div className="flex flex-col divide-y">
        {decisions.map((x, i) => (
          <div className="flex flex-col gap-1 py-2 detail-body" key={i}>
            <Md className="detail-entry" text={eventMarkdown(x.body)} />
            <p className="detail-meta">
              {x.author} · {rel(x.at)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
