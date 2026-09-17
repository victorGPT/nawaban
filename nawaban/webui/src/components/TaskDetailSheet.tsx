import { t as tr, statusLabel, useLocale } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import {
  RiCheckLine as Check,
  RiFileCopyLine as Copy,
  RiTerminalBoxLine as TerminalSquare,
  RiArrowLeftLine,
} from "@remixicon/react";
import { OverflowText } from "@/components/OverflowText";
import { TaskContext } from "@/components/TaskContext";
import { Md } from "@/components/Md";
import { NawabanDialog, LoadState, useNotice } from "@/components/NawabanUI";
import { Button } from "@/components/base/buttons/button";
import { LinkButton } from "@/components/base/buttons/link-button";
import {
  SettingsCard,
  SettingsRow,
  SettingsValueField,
} from "@/components/application/settings/settings-rows";
import { fetchKin, fetchTask } from "@/lib/api";
import type {
  KinResponse,
  TaskDetail,
  TaskEvent,
  TaskLetter,
  TaskSession,
} from "@/lib/types";
import { WAIT, scopePaths, textItems } from "@/lib/nawaban-model";
import { cn } from "@/lib/utils";

// Detail typography is defined in styles/nawaban-typography.css.
const FOLD = 3; // Visible relation count; activity defaults to five entries.

function rel(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return tr("justNow");
  if (s < 3600) return tr("minutesAgo", { count: Math.floor(s / 60) });
  if (s < 86400) return tr("hoursAgo", { count: Math.floor(s / 3600) });
  return tr("daysAgo", { count: Math.floor(s / 86400) });
}

const isUrl = (v: string) => /^https?:\/\/\S+$/.test(v.trim());

function CopyBtn({ text, label }: { text: string; label?: string }) {
  useLocale();
  const [ok, setOk] = useState(false);
  const notice = useNotice();
  return (
    <LinkButton
      className="inline-flex items-center gap-1 detail-action hover:text-text-primary"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1200);
          })
          .catch(() => notice(tr("copyFailed"), "error"));
      }}
      title={tr("copyText", { text })}
      type="button"
    >
      {ok ? <Check className="size-3" /> : <Copy className="size-3" />}
      {label}
    </LinkButton>
  );
}

function IdLink({
  id,
  onSelect,
}: {
  id: string;
  onSelect: (id: string) => void;
}) {
  useLocale();
  return (
    <LinkButton
      className="detail-code-link"
      onClick={() => onSelect(id)}
      type="button"
    >
      {id}
    </LinkButton>
  );
}

function Fold<T>({
  items,
  n,
  render,
}: {
  items: T[];
  n: number;
  render: (x: T, i: number) => React.ReactNode;
}) {
  useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, n);
  return (
    <>
      {shown.map(render)}
      {items.length > n && (
        <LinkButton
          className="detail-action self-start"
          onClick={() => setAll((v) => !v)}
          type="button"
        >
          {all ? tr("collapse") : tr("moreItems", { count: items.length - n })}
        </LinkButton>
      )}
    </>
  );
}

// Collapse long activity prose to three lines until expanded.
function Clamp({ text }: { text: string }) {
  useLocale();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Md className={open ? "" : "line-clamp-3"} text={text} />
      <LinkButton
        className="detail-action"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? tr("collapse") : tr("expandFullText")}
      </LinkButton>
    </div>
  );
}

function H({ children, n }: { children: React.ReactNode; n?: number }) {
  useLocale();
  return (
    <h3 className="detail-section-title mb-3 flex items-center gap-2">
      {children}
      {n != null && <span className="detail-meta">{n}</span>}
    </h3>
  );
}

function Bullets({ items }: { items: string[] }) {
  useLocale();
  return (
    <ul className="detail-list list-disc pl-5">
      {items.map((s, i) => (
        <li key={i}>
          <Md text={s} />
        </li>
      ))}
    </ul>
  );
}

// Merge events and session milestones into one chronological activity stream.
type Tick =
  | { t: number; kind: "session"; s: TaskSession; phase: "start" | "end" }
  | { t: number; kind: "event"; e: TaskEvent }
  | { t: number; kind: "letter"; l: TaskLetter };

function timeline(d: TaskDetail): Tick[] {
  const ticks: Tick[] = d.events.map((e) => ({
    t: e.created_at,
    kind: "event",
    e,
  }));
  for (const l of d.letters ?? [])
    ticks.push({ t: l.created_at, kind: "letter", l });
  for (const s of d.sessions) {
    ticks.push({ t: s.started_at, kind: "session", s, phase: "start" });
    if (s.ended_at)
      ticks.push({ t: s.ended_at, kind: "session", s, phase: "end" });
  }
  return ticks.sort((a, b) => b.t - a.t);
}

function Timeline({ d }: { d: TaskDetail }) {
  useLocale();
  const ticks = useMemo(() => timeline(d), [d]);
  return (
    <div className="flex flex-col gap-3">
      <Fold
        items={ticks}
        n={5}
        render={(k, i) =>
          k.kind === "session" ? (
            <div key={i}>
              <div className="min-w-0 detail-body">
                <p className="detail-meta">
                  <span className="detail-meta">{k.s.owner}</span>{" "}
                  <span className="text-text-secondary">
                    {k.phase === "start"
                      ? tr("start")
                      : tr("wrapupOutcome", { outcome: k.s.outcome ?? "?" })}{" "}
                    · {rel(k.t)}
                  </span>
                </p>
                {k.phase === "end" && k.s.summary && (
                  <Md className="mt-2 detail-entry" text={k.s.summary} />
                )}
                {(k.phase === "end" || !k.s.ended_at) && k.s.note && (
                  <div className="mt-1 detail-meta">
                    <Clamp text={k.s.note} />
                  </div>
                )}
              </div>
            </div>
          ) : k.kind === "letter" ? (
            <div className="detail-meta" key={i}>
              <div className="min-w-0">
                <span>{tr("notifications")}</span>{" "}
                <span className="detail-meta">{k.l.kind}</span>
                {!k.l.read_at && (
                  <span className="ml-1 text-status-yellow-text">{tr("unread")}</span>
                )}{" "}
                · {rel(k.t)}
                <Clamp text={k.l.msg} />
              </div>
            </div>
          ) : (
            <div className="detail-meta" key={i}>
              <div className="min-w-0">
                <span>{k.e.author ?? "?"}</span>{" "}
                <span className="detail-meta">{k.e.kind}</span> ·{" "}
                {rel(k.t)}
                <Clamp text={k.e.body} />
              </div>
            </div>
          )
        }
      />
    </div>
  );
}

// Read-only properties use a consistent label/value layout.
function Attr({
  label,
  value,
  mono,
  empty,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  empty?: string;
}) {
  useLocale();
  const isEmpty = value == null || value === "";
  return (
    <SettingsRow label={label}>
      <SettingsValueField className={cn("detail-value", mono && "detail-mono")}>
        {isEmpty ? (empty ?? tr("noValue", { label })) : value}
      </SettingsValueField>
    </SettingsRow>
  );
}

function ResumeBlock({ s }: { s: TaskSession }) {
  useLocale();
  return (
    <div className="detail-resume flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5 detail-meta">
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="truncate">
          {s.owner} · {s.outcome ?? tr("inProgress")}
        </span>
      </span>
      <CopyBtn label="resume" text={`claude --resume ${s.session_id}`} />
    </div>
  );
}

function Ids({
  ids,
  onSelect,
}: {
  ids: string[];
  onSelect: (id: string) => void;
}) {
  useLocale();
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <IdLink id={id} key={id} onSelect={onSelect} />
      ))}
    </span>
  );
}

export function TaskDetailSheet({
  taskId,
  onOpenChange,
  onSelectTask,
  onBack,
}: {
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectTask: (taskId: string) => void;
  onBack?: () => void;
}) {
  useLocale();
  const [d, setD] = useState<TaskDetail | null>(null);
  const [kin, setKin] = useState<KinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let active = true;
    setD(null);
    setKin(null);
    setError(null);
    Promise.all([fetchTask(taskId), fetchKin(taskId)])
      .then(([task, relationships]) => {
        if (!active) return;
        setD(task);
        setKin(relationships);
      })
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [taskId]);

  const L = kin?.lineage;
  const files = scopePaths(d?.touches ?? null);
  const success = textItems(d?.success);
  const constraints = textItems(d?.constraints);
  // Evidence belongs in the reading column; short PR and SHA pointers stay in the rail.
  const acceptance = d?.refs.filter((r) => r.kind === "acceptance_run") ?? [];
  const shortRefs = d?.refs.filter((r) => r.kind !== "acceptance_run") ?? [];
  const times = d
    ? [
        tr("createdAt", { time: rel(d.created_at) }),
        d.started_at && tr("startedAt", { time: rel(d.started_at) }),
        d.completed_at && tr("completedAt", { time: rel(d.completed_at) }),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <NawabanDialog
      open={taskId != null}
      onClose={() => onOpenChange(false)}
      title={tr("taskDetails", { id: taskId ?? "" })}
      wide
      header={
        <div className="detail-breadcrumb">
          {onBack && (
            <Button
              variant="ghost"
              size="xs"
              leadingIcon={RiArrowLeftLine}
              onClick={onBack}
            >{tr("back")}</Button>
          )}
          <span>{d?.epic ?? tr("task")} / </span>
          <code>{taskId}</code>
          {taskId && <CopyBtn text={taskId} />}
        </div>
      }
    >
      {error && <LoadState error>{error}</LoadState>}
      {!d && !error && <LoadState>{tr("loadingTasks")}</LoadState>}
      {d && (
        <div className="detail-scroll">
          <div className="detail-grid">
            <main className="detail-reading">
              <div className="flex flex-col gap-4">
                <h2 className="detail-task-title">{d.title}</h2>
                {d.now && (
                  <SettingsCard className="detail-now">
                    <span className="detail-subheading">{tr("currentProgress")}</span>
                    <Md text={d.now} />
                  </SettingsCard>
                )}
              </div>

              {d.context && d.context !== d.now && (
                <section>
                  <H>{tr("context")}</H>
                  <TaskContext
                    key={d.id}
                    context={d.context}
                    decisions={d.decisions}
                    onSelectTask={onSelectTask}
                  />
                </section>
              )}

              {success.length || constraints.length ? (
                <section className="grid gap-6 md:grid-cols-2">
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
              ) : null}

              {kin && kin.blocked_by.length > 0 && (
                <section>
                  <H n={kin.blocked_by.length}>{tr("blockedBy")}</H>
                  <p className="mb-2 detail-meta">
                    {tr("stuckAt")}
                    <IdLink id={kin.stuck_at!} onSelect={onSelectTask} />
                  </p>
                  <div className="flex flex-col divide-y">
                    {kin.blocked_by.map((t) => (
                      <div
                        className="py-2 detail-body"
                        key={t.id}
                        style={{ marginLeft: (t.depth - 1) * 12 }}
                      >
                        <IdLink id={t.id} onSelect={onSelectTask} />
                        <span className="ml-2 detail-meta">{t.status}</span>
                        <p className="mt-1 detail-body">{t.title}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {kin && kin.unblocks.length > 0 && (
                <section>
                  <H n={kin.unblocks.length}>{tr("unblocks")}</H>
                  <div className="flex flex-col divide-y">
                    {kin.unblocks.map((t) => (
                      <div className="py-2 detail-body" key={t.id}>
                        <IdLink id={t.id} onSelect={onSelectTask} />
                        <span className="ml-2 detail-meta">{t.status}</span>
                        <p className="mt-1 detail-body">{t.title}</p>
                        {t.others_waiting > 0 && (
                          <p className="detail-meta">
                            {tr("othersWaiting", { count: t.others_waiting })}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {d.decisions.length > 0 && (
                <section>
                  <H n={d.decisions.length}>{tr("decisions")}</H>
                  <div className="flex flex-col divide-y">
                    {d.decisions.map((x) => {
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
              )}

              {acceptance.length > 0 && (
                <section>
                  <H n={acceptance.length}>{tr("evidence")}</H>
                  <div className="flex flex-col gap-3">
                    <Fold
                      items={acceptance}
                      n={2}
                      render={(r, i) => (
                        <div className="detail-entry" key={i}>
                          {isUrl(r.value) ? (
                            <LinkButton
                              size="xs"
                              className="detail-code-link whitespace-normal break-all justify-start"
                              href={r.value}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {r.value}
                            </LinkButton>
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
              )}

              <section>
                <H n={timeline(d).length}>{tr("activity")}</H>
                <Timeline d={d} />
              </section>
            </main>

            <aside className="detail-properties-rail">
              {d.sessions[0] && <ResumeBlock s={d.sessions[0]} />}
              <SettingsCard className="detail-attribute-group">
                <p className="attribute-heading">{tr("properties")}</p>
                <Attr
                  label={tr("stageLabel")}
                  value={
                    statusLabel(d.status)
                  }
                />
                <Attr
                  label={tr("waitingOn")}
                  value={
                    d.waiting_on ? (
                      <span className="text-status-yellow-text">
                        {WAIT[d.waiting_on] ?? d.waiting_on}
                      </span>
                    ) : null
                  }
                  empty={tr("notWaiting")}
                />
                <Attr label={tr("owner")} mono value={d.owner} empty={tr("noOwner")} />
                <Attr label={tr("epic")} value={d.epic} />
                <Attr label={tr("decisionDocument")} mono value={d.adr} />
                <Attr label={tr("time")} value={times} />
              </SettingsCard>
              <SettingsCard className="detail-attribute-group detail-long-attributes">
                <p className="attribute-heading">{tr("relationships")}</p>
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
                                <LinkButton
                                  size="xs"
                                  className="detail-code-link detail-reference-link"
                                  href={r.value}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  <OverflowText className="detail-reference-value" text={r.value} />
                                </LinkButton>
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
            </aside>
          </div>
        </div>
      )}
    </NawabanDialog>
  );
}
