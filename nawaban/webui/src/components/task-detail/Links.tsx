import { t as tr, useLocale } from "@/i18n";
import { Fold } from "@/components/disclosure/Fold";
import { OverflowText } from "@/components/OverflowText";
import { isUrl, rel } from "@/components/task-detail/format";
import { H } from "@/components/task-detail/parts";
import { Button } from "@/components/ui/button";
import { linkParts } from "@/lib/nawaban-model";
import type { TaskEvent } from "@/lib/types";

const FOLD = 5; // Links shown before the list folds.

export function Links({ links }: { links: TaskEvent[] }) {
  useLocale();
  if (links.length === 0) return null;
  return (
    <section>
      <H n={links.length}>{tr("reference")}</H>
      <div className="detail-reference-list flex flex-col gap-2">
        <Fold
          items={links}
          n={FOLD}
          render={(e, i) => {
            const { kind, value, note } = linkParts(e.body);
            return (
              <div className="detail-reference" key={i}>
                {kind && <span className="detail-meta detail-reference-kind">{kind}</span>}
                {isUrl(value) ? (
                  <Button
                    variant="link"
                    size="link-xs"
                    className="detail-code-link detail-reference-link"
                    render={<a href={value} rel="noreferrer" target="_blank" />}
                  >
                    <OverflowText className="detail-reference-value" text={value} />
                  </Button>
                ) : (
                  <OverflowText className="detail-reference-value" text={value} />
                )}
                {note && <span className="detail-meta detail-reference-note">{note}</span>}
                <span className="detail-meta">{rel(e.at)}</span>
              </div>
            );
          }}
        />
      </div>
    </section>
  );
}
