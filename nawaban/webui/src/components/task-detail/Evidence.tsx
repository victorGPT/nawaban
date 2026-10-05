import { t as tr, useLocale } from "@/i18n";
import { Fold } from "@/components/disclosure/Fold";
import { Md } from "@/components/Md";
import { isUrl, rel } from "@/components/task-detail/format";
import { H } from "@/components/task-detail/parts";
import { Button } from "@/components/ui/button";
import type { TaskRef } from "@/lib/types";

// Evidence belongs in the reading column; short PR and SHA pointers stay in the rail.
export function Evidence({ refs }: { refs: TaskRef[] }) {
  useLocale();
  const acceptance = refs.filter((r) => r.kind === "acceptance_run");
  if (acceptance.length === 0) return null;
  return (
    <section>
      <H n={acceptance.length}>{tr("evidence")}</H>
      <div className="flex flex-col gap-3">
        <Fold
          items={acceptance}
          n={2}
          render={(r, i) => (
            <div className="detail-entry" key={i}>
              {isUrl(r.value) ? (
                <Button
                  variant="link"
                  size="link-xs"
                  className="detail-code-link whitespace-normal break-all justify-start"
                  render={<a href={r.value} rel="noreferrer" target="_blank" />}
                >
                  {r.value}
                </Button>
              ) : (
                <Md text={r.value} />
              )}
              {r.note && (
                <Md className="mt-1 detail-meta" text={r.note} />
              )}
              <p className="mt-1 detail-meta">
                {rel(r.created_at)}
              </p>
            </div>
          )}
        />
      </div>
    </section>
  );
}
