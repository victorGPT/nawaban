import { t as tr, useLocale } from "@/i18n";
import { Md } from "@/components/Md";
import { rel } from "@/components/task-detail/format";
import { H } from "@/components/task-detail/parts";
import type { TaskDecision } from "@/lib/types";

export function Decisions({ decisions }: { decisions: TaskDecision[] }) {
  useLocale();
  if (decisions.length === 0) return null;
  return (
    <section>
      <H n={decisions.length}>{tr("decisions")}</H>
      <div className="flex flex-col divide-y">
        {decisions.map((x) => {
          const rej = Array.isArray(x.rejected)
            ? (
                x.rejected as (
                  string | { option?: string; reason?: string }
                )[]
              ).map((r) =>
                typeof r === "string"
                  ? r
                  : `${r.option ?? ""}${r.reason ? ` —— ${r.reason}` : ""}`,
              )
            : typeof x.rejected === "string" ? [x.rejected] : [];
          return (
            <div className="py-2 detail-body" key={x.id}>
              <Md className="detail-subheading" text={x.question} />
              <Md className="mt-1" text={x.verdict} />
              {rej.length > 0 && (
                <ul className="mt-1 list-disc pl-4 detail-meta">
                  {rej.map((r, i) => (
                    <li key={i}>{tr("rejected")}<Md inline text={r} />
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 detail-meta">
                {x.decided_by} · {rel(x.created_at)}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
