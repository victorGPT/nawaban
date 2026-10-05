import { t as tr, useLocale } from "@/i18n";
import { useMemo } from "react";
import { Clamp } from "@/components/disclosure/Clamp";
import { Fold } from "@/components/disclosure/Fold";
import { Md } from "@/components/Md";
import { rel } from "@/components/task-detail/format";
import { H } from "@/components/task-detail/parts";
import type {
  TaskDetail,
  TaskEvent,
  TaskLetter,
  TaskSession,
} from "@/lib/types";

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

export function Activity({ d }: { d: TaskDetail }) {
  useLocale();
  return (
    <section>
      <H n={timeline(d).length}>{tr("activity")}</H>
      <Timeline d={d} />
    </section>
  );
}
