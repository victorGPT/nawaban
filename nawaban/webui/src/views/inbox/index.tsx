import { t, useLocale } from "@/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AskCard } from "@/components/inbox/AskCard";
import { AskIndex } from "@/components/inbox/AskIndex";
import { SelfApprovedDigest } from "@/components/inbox/SelfApprovedDigest";
import { LoadState } from "@/components/NawabanUI";
import { inboxMatches } from "@/lib/nawaban-model";
import { fetchInbox, postAnswer, type Project } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";

type InboxViewProps = {
  query: string;
  project: Project;
  onSelectTask: (id: string) => void;
};

export function InboxView(props: InboxViewProps) {
  // A project change removes previous answer controls and their draft/dialog state.
  return <ProjectInbox key={JSON.stringify(props.project)} {...props} />;
}

function ProjectInbox({ query, project, onSelectTask }: InboxViewProps) {
  useLocale();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<{ key: "inboxUnavailable" } | { message: string } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const active = useRef(false);
  const requestVersion = useRef(0);
  const load = useCallback(() => {
    // An answer may finish after its project view has already unmounted.
    if (!active.current) return;
    const version = ++requestVersion.current;
    fetchInbox(project)
      .then((d) => {
        if (!active.current || version !== requestVersion.current) return;
        if (d.unavailable) {
          setError({ key: "inboxUnavailable" });
          return;
        }
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (active.current && version === requestVersion.current) setError({ message: String(e) });
      });
  }, [project]);
  useEffect(() => {
    active.current = true;
    load();
    return () => {
      active.current = false;
      requestVersion.current += 1;
    };
  }, [load]);

  const q = query.trim();
  const groups = useMemo(
    () =>
      (data?.groups ?? [])
        .map((g) => ({
          ...g,
          items: q ? g.items.filter((a) => inboxMatches(a, q)) : g.items,
        }))
        .filter((g) => g.items.length),
    [data, q],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // Select the first remaining item after processing or filtering the current item.
  const selected = flat.find((a) => a.id === selectedId) ?? flat[0] ?? null;

  const errorText = error ? ("key" in error ? t(error.key) : error.message) : null;
  if (errorText && !data) return <LoadState error>{errorText}</LoadState>;
  if (!data) return <LoadState>{t("loadingInbox")}</LoadState>;

  return (
    <div className="inbox-layout">
      <div className="inbox-index">
        <div className="px-4 py-4 text-body-regular text-text-secondary">
          {data.total
            ? t("inboxPending", { count: data.total, days: data.oldest_days })
            : t("inboxEmptyDecision")}
          {t("inboxFlow", { raised: data.flow.raised_7d, closed: data.flow.closed_7d })}
        </div>
        <AskIndex groups={groups} selected={selected} onSelect={setSelectedId} />
        {data.self_approved && data.self_approved.length > 0 && (
          <div className="p-3">
            <SelfApprovedDigest items={data.self_approved} />
          </div>
        )}
      </div>

      <div className="inbox-detail">
        {errorText && <LoadState error>{t("inboxRefreshFailed", { error: errorText })}</LoadState>}
        {data.groups.some((g) => g.items.length > 0) && (
          <div
            className="inbox-reading mx-auto max-w-2xl p-6"
            hidden={!selected}
          >
            {data.groups
              .flatMap((g) => g.items)
              .map((a) => (
                <div hidden={a.id !== selected?.id} key={a.id}>
                  <AskCard
                    ask={a}
                    onAnswer={(verdict, reject) => postAnswer(a.id, verdict, reject)}
                    onDone={load}
                    onSelectTask={onSelectTask}
                  />
                </div>
              ))}
          </div>
        )}
        {!selected && (
          <p className="p-8 text-body-regular text-text-secondary">
            {q ? t("inboxNoMatches") : t("inboxEmpty")}
          </p>
        )}
      </div>
    </div>
  );
}
