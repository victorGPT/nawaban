import { t as tr, statusLabel, waitingLabel } from "@/i18n";
// Read-only task details: narrative on the left, properties on the right.
import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  Circle,
  Clock,
  Copy,
  FileText,
  GitFork,
  Hourglass,
  Layers,
  Link2,
  Mail,
  TerminalSquare,
  User,
} from "lucide-react";
import { Md } from "@/components/Md";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { fetchKin, fetchTask } from "@/lib/api";
import type { KinResponse, TaskDetail, TaskEvent, TaskLetter, TaskSession } from "@/lib/types";
import { cn } from "@/lib/utils";

const FOLD = 3;

function rel(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return tr("justNow");
  if (s < 3600) return tr("minutesAgo", { count: Math.floor(s / 60) });
  if (s < 86400) return tr("hoursAgo", { count: Math.floor(s / 3600) });
  return tr("daysAgo", { count: Math.floor(s / 86400) });
}

const isUrl = (v: string) => /^https?:\/\/\S+$/.test(v.trim());

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        });
      }}
      title={tr("copyText", { text })}
      type="button"
    >
      {ok ? <Check className="size-3" /> : <Copy className="size-3" />}
      {label}
    </button>
  );
}

function IdLink({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  return (
    <button className="font-mono text-xs underline underline-offset-2" onClick={() => onSelect(id)} type="button">
      {id}
    </button>
  );
}

function Fold<T>({ items, n, render }: { items: T[]; n: number; render: (x: T, i: number) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, n);
  return (
    <>
      {shown.map(render)}
      {items.length > n && (
        <button
          className="self-start text-xs text-muted-foreground underline underline-offset-2"
          onClick={() => setAll((v) => !v)}
          type="button"
        >
          {all ? tr("collapse") : tr("moreItems", { count: items.length - n })}
        </button>
      )}
    </>
  );
}

function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      className={cn("block w-full cursor-pointer text-left", !open && "line-clamp-3")}
      onClick={() => setOpen((v) => !v)}
      title={open ? tr("collapse") : tr("expand")}
      type="button"
    >
      <Md text={text} />
    </button>
  );
}

function H({ children, n }: { children: React.ReactNode; n?: number }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-[15px] font-semibold">
      {children}
      {n != null && <span className="text-xs font-normal text-muted-foreground">{n}</span>}
    </h3>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-4 text-sm">
      {items.map((s, i) => (
        <li key={i}><Md text={s} /></li>
      ))}
    </ul>
  );
}

type Tick =
  | { t: number; kind: "session"; s: TaskSession; phase: "start" | "end" }
  | { t: number; kind: "event"; e: TaskEvent }
  | { t: number; kind: "letter"; l: TaskLetter };

function timeline(d: TaskDetail): Tick[] {
  const ticks: Tick[] = d.events.map((e) => ({ t: e.created_at, kind: "event", e }));
  for (const l of d.letters ?? []) ticks.push({ t: l.created_at, kind: "letter", l });
  for (const s of d.sessions) {
    ticks.push({ t: s.started_at, kind: "session", s, phase: "start" });
    if (s.ended_at) ticks.push({ t: s.ended_at, kind: "session", s, phase: "end" });
  }
  return ticks.sort((a, b) => b.t - a.t);
}

function Timeline({ d }: { d: TaskDetail }) {
  const ticks = useMemo(() => timeline(d), [d]);
  return (
    <div className="flex flex-col gap-3">
      <Fold
        items={ticks}
        n={5}
        render={(k, i) =>
          k.kind === "session" ? (
            <div className="flex gap-3" key={i}>
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-avatar text-[10px] font-semibold text-avatar-foreground">
                {k.s.owner.split(":").pop()!.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0 text-sm">
                <p>
                  <span className="font-medium">{k.s.owner}</span>{" "}
                  <span className="text-muted-foreground">
                    {k.phase === "start" ? tr("start") : tr("wrapupOutcome", { outcome: k.s.outcome ?? "?" })} · {rel(k.t)}
                  </span>
                </p>
                {k.phase === "end" && k.s.summary && (
                  <Md className="mt-1 rounded-md border bg-panel px-3 py-2 text-xs" text={k.s.summary} />
                )}
                {(k.phase === "end" || !k.s.ended_at) && k.s.note && (
                  <div className="mt-1 text-xs text-muted-foreground"><Clamp text={k.s.note} /></div>
                )}
              </div>
            </div>
          ) : k.kind === "letter" ? (
            <div className="flex gap-3 text-ui" key={i}>
              <Mail className={cn("mt-1 size-5 shrink-0 p-0.5", k.l.read_at ? "text-muted-foreground" : "text-warn-foreground")} />
              <p className="min-w-0 text-muted-foreground">
                <span className="text-fg-secondary">{tr("notifications")}</span>{" "}
                <span className="font-medium">{k.l.kind}</span>
                {!k.l.read_at && <span className="ml-1 text-warn-foreground">{tr("unread")}</span>} · {rel(k.t)}
                <Clamp text={k.l.msg} />
              </p>
            </div>
          ) : (
            <div className="flex gap-3 text-ui" key={i}>
              <span className="mt-1 size-5 shrink-0 text-center text-muted-foreground">·</span>
              <p className="min-w-0 text-muted-foreground">
                <span className="text-fg-secondary">{k.e.author ?? "?"}</span>{" "}
                <span className="font-medium">{k.e.kind}</span> · {rel(k.t)}
                <Clamp text={k.e.body} />
              </p>
            </div>
          )
        }
      />
    </div>
  );
}

function Attr({ icon: Icon, label, value, mono, empty }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  empty?: string;
}) {
  const isEmpty = value == null || value === "";
  return (
    <div className="flex min-h-7 items-start gap-1.5 py-1 text-ui font-medium" title={label}>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className={cn("min-w-0 break-words", mono && "font-mono text-xs", isEmpty ? "text-muted-foreground" : "text-fg-secondary")}>
        {isEmpty ? (empty ?? tr("noValue", { label })) : value}
      </span>
    </div>
  );
}

function ResumeBlock({ s }: { s: TaskSession }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="truncate">{s.owner} · {s.outcome ?? tr("inProgress")}</span>
      </span>
      <CopyBtn label="resume" text={`claude --resume ${s.session_id}`} />
    </div>
  );
}

function Ids({ ids, onSelect }: { ids: string[]; onSelect: (id: string) => void }) {
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <IdLink id={id} key={id} onSelect={onSelect} />
      ))}
    </span>
  );
}

export function TaskDetailSheet({ taskId, onOpenChange, onSelectTask }: {
  taskId: string | null;
  onOpenChange: (open: boolean) => void;
  onSelectTask: (taskId: string) => void;
}) {
  const [d, setD] = useState<TaskDetail | null>(null);
  const [kin, setKin] = useState<KinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) return;
    setD(null);
    setKin(null);
    setError(null);
    Promise.all([fetchTask(taskId), fetchKin(taskId)])
      .then(([task, relationships]) => {
        setD(task);
        setKin(relationships);
      })
      .catch((e) => setError(String(e)));
  }, [taskId]);

  const L = kin?.lineage;

  const acceptance = d?.refs.filter((r) => r.kind === "acceptance_run") ?? [];
  const shortRefs = d?.refs.filter((r) => r.kind !== "acceptance_run") ?? [];
  const times = d
    ? [tr("createdAt", { time: rel(d.created_at) }), d.started_at && tr("startedAt", { time: rel(d.started_at) }), d.completed_at && tr("completedAt", { time: rel(d.completed_at) })]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <Sheet onOpenChange={onOpenChange} open={taskId != null}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-[1000px]">
        {!d && <SheetTitle className="sr-only">{taskId}</SheetTitle>}
        {error && <p className="p-6 text-destructive">{tr("loadError")}{error}</p>}
        {!d && !error && <p className="p-6 text-muted-foreground">{tr("loading")}</p>}
        {d && (
          <div className="flex min-h-full flex-col">
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-b px-4 text-ui text-muted-foreground">
              <span>{d.epic ?? tr("noEpic")}</span>
              <span>›</span>
              <span className="font-mono text-fg-secondary">{d.id}</span>
              <CopyBtn text={d.id} />
            </div>

            <div className="grid flex-1 md:grid-cols-[minmax(0,1fr)_300px]">
              <main className="flex flex-col gap-8 px-12 pt-12 pb-10 [&>section]:border-t [&>section]:pt-6">
                <div className="flex flex-col gap-4">
                  <SheetTitle className="text-2xl leading-8 font-semibold">{d.title}</SheetTitle>
                  {d.now && <Md className="text-[15px] leading-6 text-fg-secondary" text={d.now} />}
                </div>

                {d.context && d.context !== d.now && (
                  <section>
                    <H>{tr("context")}</H>
                    <Md className="text-sm" text={d.context} />
                  </section>
                )}

                {(d.success?.length || d.constraints?.length) ? (
                  <section className="grid gap-6 md:grid-cols-2">
                    {d.success && d.success.length > 0 && (
                      <div>
                        <H n={d.success.length}>{tr("criteria")}</H>
                        <Bullets items={d.success} />
                      </div>
                    )}
                    {d.constraints && d.constraints.length > 0 && (
                      <div>
                        <H n={d.constraints.length}>{tr("constraints")}</H>
                        <Bullets items={d.constraints} />
                      </div>
                    )}
                  </section>
                ) : null}

                {kin && kin.blocked_by.length > 0 && (
                  <section>
                    <H n={kin.blocked_by.length}>{tr("blockedBy")}</H>
                    <p className="mb-2 text-xs text-muted-foreground">
                      {tr("stuckAt")}<IdLink id={kin.stuck_at!} onSelect={onSelectTask} />
                    </p>
                    <div className="flex flex-col divide-y">
                      {kin.blocked_by.map((t) => (
                        <div className="py-2 text-sm" key={t.id} style={{ marginLeft: (t.depth - 1) * 12 }}>
                          <IdLink id={t.id} onSelect={onSelectTask} />
                          <span className="ml-2 text-xs text-muted-foreground">{statusLabel(t.status)}</span>
                          <p className="mt-0.5 text-xs">{t.title}</p>
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
                        <div className="py-2 text-sm" key={t.id}>
                          <IdLink id={t.id} onSelect={onSelectTask} />
                          <span className="ml-2 text-xs text-muted-foreground">{statusLabel(t.status)}</span>
                          <p className="mt-0.5 text-xs">{t.title}</p>
                          {t.others_waiting > 0 && (
                            <p className="text-xs text-muted-foreground">{tr("othersWaiting", { count: t.others_waiting })}</p>
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
                          ? (x.rejected as (string | { option?: string; reason?: string })[]).map((r) =>
                              typeof r === "string" ? r : `${r.option ?? ""}${r.reason ? ` —— ${r.reason}` : ""}`)
                          : [];
                        return (
                          <div className="py-2 text-sm" key={x.id}>
                            <Md className="font-medium" text={x.question} />
                            <Md className="mt-1" text={x.verdict} />
                            {rej.length > 0 && (
                              <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                                {rej.map((r, i) => (
                                  <li key={i}>{tr("rejected")}<Md inline text={r} /></li>
                                ))}
                              </ul>
                            )}
                            <p className="mt-1 text-xs text-muted-foreground">
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
                          <div className="rounded-md border bg-panel px-3 py-2" key={i}>
                            {isUrl(r.value)
                              ? <a className="text-sm underline underline-offset-2 break-all" href={r.value} rel="noreferrer" target="_blank">{r.value}</a>
                              : <Md className="text-sm" text={r.value} />}
                            {r.note && <Md className="mt-1 text-xs text-muted-foreground" text={r.note} />}
                            <p className="mt-1 text-xs text-muted-foreground">{rel(r.created_at)}</p>
                          </div>
                        )}
                      />
                    </div>
                  </section>
                )}

                <section>
                  <H n={d.events.length + d.sessions.length + (d.letters?.length ?? 0)}>{tr("activity")}</H>
                  <Timeline d={d} />
                </section>
              </main>

              <aside className="flex flex-col gap-10 px-6 pt-12 pb-10">
                {d.sessions[0] && <ResumeBlock s={d.sessions[0]} />}
                <div>
                  <p className="mb-2 text-ui font-medium text-muted-foreground">{tr("properties")}</p>
                  <Attr icon={Circle} label={tr("status")} value={statusLabel(d.status)} />
                  <Attr icon={Hourglass} label={tr("waitingOn")} value={d.waiting_on ? <span className="text-warn-foreground">{waitingLabel(d.waiting_on)}</span> : null} empty={tr("notWaiting")} />
                  <Attr icon={User} label="owner" mono value={d.owner} empty={tr("noOwner")} />
                  <Attr icon={Layers} label="epic" value={d.epic} />
                  <Attr icon={BookOpen} label="adr" value={d.adr} />
                  <Attr icon={Clock} label={tr("time")} value={times} />
                </div>
                <div>
                  <p className="mb-2 text-ui font-medium text-muted-foreground">{tr("relationships")}</p>
                  {L?.split_from && <Attr icon={GitFork} label={tr("splitFrom")} value={<IdLink id={L.split_from} onSelect={onSelectTask} />} />}
                  {L && L.split_out.length > 0 && <Attr icon={GitFork} label={tr("splitOut")} value={<Ids ids={L.split_out} onSelect={onSelectTask} />} />}
                  {L && L.supersedes.length > 0 && <Attr icon={GitFork} label={tr("supersedes")} value={<Ids ids={L.supersedes} onSelect={onSelectTask} />} />}
                  {L && L.superseded_by.length > 0 && <Attr icon={GitFork} label={tr("supersededBy")} value={<Ids ids={L.superseded_by} onSelect={onSelectTask} />} />}
                  <Attr
                    icon={FileText}
                    label="touches"
                    mono
                    value={d.touches?.length ? (
                      <span className="flex flex-col gap-0.5">
                        <Fold items={d.touches} n={FOLD} render={(t, i) => <span className="break-all" key={i}>{t}</span>} />
                      </span>
                    ) : null}
                  />
                  <Attr
                    icon={Link2}
                    label={tr("reference")}
                    mono
                    value={shortRefs.length ? (
                      <span className="flex flex-col gap-0.5">
                        <Fold
                          items={shortRefs}
                          n={FOLD}
                          render={(r, i) => (
                            <span className="break-all" key={i}>
                              <span className="text-muted-foreground">{r.kind} </span>
                              {isUrl(r.value) ? <a className="underline underline-offset-2" href={r.value} rel="noreferrer" target="_blank">{r.value}</a> : r.value}
                              {r.note && <span className="text-muted-foreground"> · {r.note}</span>}
                            </span>
                          )}
                        />
                      </span>
                    ) : null}
                  />
                </div>
              </aside>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
