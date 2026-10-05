import { t as tr, useLocale } from "@/i18n";
import { Fold } from "@/components/disclosure/Fold";
import { OverflowText } from "@/components/OverflowText";
import { isUrl } from "@/components/task-detail/format";
import { Attr, IdLink, Ids } from "@/components/task-detail/parts";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/application/settings/settings-rows";
import { scopePaths } from "@/lib/nawaban-model";
import type { KinResponse, TaskDetail } from "@/lib/types";

const FOLD = 3; // References shown before the list folds.

export function Relationships({
  d,
  lineage: L,
  onSelectTask,
}: {
  d: TaskDetail;
  lineage: KinResponse["lineage"] | undefined;
  onSelectTask: (id: string) => void;
}) {
  useLocale();
  const files = scopePaths(d.touches ?? null);
  const shortRefs = d.refs.filter((r) => r.kind !== "acceptance_run");
  return (
    <SettingsCard className="detail-attribute-group detail-long-attributes">
      <h3 className="attribute-heading">{tr("relationships")}</h3>
      {L?.split_from && (
        <Attr
          label={tr("splitFrom")}
          value={<IdLink id={L.split_from} onSelect={onSelectTask} />}
        />
      )}
      {L && L.split_out.length > 0 && (
        <Attr
          label={tr("splitOut")}
          value={<Ids ids={L.split_out} onSelect={onSelectTask} />}
        />
      )}
      {L && L.supersedes.length > 0 && (
        <Attr
          label={tr("supersedes")}
          value={<Ids ids={L.supersedes} onSelect={onSelectTask} />}
        />
      )}
      {L && L.superseded_by.length > 0 && (
        <Attr
          label={tr("supersededBy")}
          value={
            <Ids ids={L.superseded_by} onSelect={onSelectTask} />
          }
        />
      )}
      <Attr
        label={tr("scope")}
        mono
        value={
          files.length ? (
            <span className="detail-file-list">
              {files.map((path, i) => (
                <code key={i}>{path}</code>
              ))}
            </span>
          ) : null
        }
      />
      <Attr
        label={tr("reference")}
        value={
          shortRefs.length ? (
            <span className="detail-reference-list">
              <Fold
                items={shortRefs}
                n={FOLD}
                render={(r, i) => (
                  <span className="detail-reference" key={i}>
                    <span className="detail-meta detail-reference-kind">
                      {r.kind}
                    </span>
                    {isUrl(r.value) ? (
                      <Button
                        variant="link"
                        size="link-xs"
                        className="detail-code-link detail-reference-link"
                        render={<a href={r.value} rel="noreferrer" target="_blank" />}
                      >
                        <OverflowText className="detail-reference-value" text={r.value} />
                      </Button>
                    ) : (
                      <OverflowText className="detail-reference-value" text={r.value} />
                    )}
                    {r.note && (
                      <span className="detail-meta detail-reference-note">
                        {r.note}
                      </span>
                    )}
                  </span>
                )}
              />
            </span>
          ) : null
        }
      />
    </SettingsCard>
  );
}
