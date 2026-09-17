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
import { WAIT, STAGES, scopePaths, textItems } from "@/lib/nawaban-model";
import { cn } from "@/lib/utils";

// Detail typography is defined in styles/nawaban-typography.css.
const FOLD = 3; // Visible relation count; activity defaults to five entries.

function rel(ts: number) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const isUrl = (v: string) => /^https?:\/\/\S+$/.test(v.trim());

function CopyBtn({ text, label }: { text: string; label?: string }) {
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
          .catch(() => notice("复制失败，请手动选择文本", "error"));
      }}
      title={`复制 ${text}`}
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
          {all ? "收起" : `还有 ${items.length - n} 条`}
        </LinkButton>
      )}
    </>
  );
}

// Collapse long activity prose to three lines until expanded.
function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Md className={open ? "" : "line-clamp-3"} text={text} />
      <LinkButton
        className="detail-action"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "收起" : "展开全文"}
      </LinkButton>
    </div>
  );
}

function H({ children, n }: { children: React.ReactNode; n?: number }) {
  return (
    <h3 className="detail-section-title mb-3 flex items-center gap-2">
      {children}
      {n != null && <span className="detail-meta">{n}</span>}
    </h3>
  );
}

function Bullets({ items }: { items: string[] }) {
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
                      ? "开工"
                      : `收尾 · ${k.s.outcome ?? "?"}`}{" "}
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
                <span>信</span>{" "}
                <span className="detail-meta">{k.l.kind}</span>
                {!k.l.read_at && (
                  <span className="ml-1 text-status-yellow-text">未读</span>
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
  const isEmpty = value == null || value === "";
  return (
    <SettingsRow label={label}>
      <SettingsValueField className={cn("detail-value", mono && "detail-mono")}>
        {isEmpty ? (empty ?? `无 ${label}`) : value}
      </SettingsValueField>
    </SettingsRow>
  );
}

function ResumeBlock({ s }: { s: TaskSession }) {
  return (
    <div className="detail-resume flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5 detail-meta">
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="truncate">
          {s.owner} · {s.outcome ?? "进行中"}
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
        `创建 ${rel(d.created_at)}`,
        d.started_at && `开工 ${rel(d.started_at)}`,
        d.completed_at && `完成 ${rel(d.completed_at)}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <NawabanDialog
      open={taskId != null}
      onClose={() => onOpenChange(false)}
      title={`任务详情 ${taskId ?? ""}`}
      wide
      header={
        <div className="detail-breadcrumb">
          {onBack && (
            <Button
              variant="ghost"
              size="xs"
              leadingIcon={RiArrowLeftLine}
              onClick={onBack}
            >
              返回
            </Button>
          )}
          <span>{d?.epic ?? "任务"} / </span>
          <code>{taskId}</code>
          {taskId && <CopyBtn text={taskId} />}
        </div>
      }
    >
      {error && <LoadState error>{error}</LoadState>}
      {!d && !error && <LoadState>正在读取任务…</LoadState>}
      {d && (
        <div className="detail-scroll">
          <div className="detail-grid">
            <main className="detail-reading">
              <div className="flex flex-col gap-4">
                <h2 className="detail-task-title">{d.title}</h2>
                {d.now && (
                  <SettingsCard className="detail-now">
                    <span className="detail-subheading">当前进展</span>
                    <Md text={d.now} />
                  </SettingsCard>
                )}
              </div>

              {d.context && d.context !== d.now && (
                <section>
                  <H>来由</H>
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
                      <H n={success.length}>成功判据</H>
                      <Bullets items={success} />
                    </div>
                  )}
                  {constraints.length > 0 && (
                    <div>
                      <H n={constraints.length}>约束</H>
                      <Bullets items={constraints} />
                    </div>
                  )}
                </section>
              ) : null}

              {kin && kin.blocked_by.length > 0 && (
                <section>
                  <H n={kin.blocked_by.length}>被挡</H>
                  <p className="mb-2 detail-meta">
                    真正卡在{" "}
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
                  <H n={kin.unblocks.length}>放开</H>
                  <div className="flex flex-col divide-y">
                    {kin.unblocks.map((t) => (
                      <div className="py-2 detail-body" key={t.id}>
                        <IdLink id={t.id} onSelect={onSelectTask} />
                        <span className="ml-2 detail-meta">{t.status}</span>
                        <p className="mt-1 detail-body">{t.title}</p>
                        {t.others_waiting > 0 && (
                          <p className="detail-meta">
                            另有 {t.others_waiting} 张还在等别人
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {d.decisions.length > 0 && (
                <section>
                  <H n={d.decisions.length}>决策</H>
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
                                <li key={i}>
                                  否:
                                  <Md inline text={r} />
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
                  <H n={acceptance.length}>验收证据</H>
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
                <H n={timeline(d).length}>活动</H>
                <Timeline d={d} />
              </section>
            </main>

            <aside className="detail-properties-rail">
              {d.sessions[0] && <ResumeBlock s={d.sessions[0]} />}
              <SettingsCard className="detail-attribute-group">
                <p className="attribute-heading">属性</p>
                <Attr
                  label="阶段"
                  value={
                    STAGES.find((s) => s.id === d.status)?.label ?? d.status
                  }
                />
                <Attr
                  label="等"
                  value={
                    d.waiting_on ? (
                      <span className="text-status-yellow-text">
                        {WAIT[d.waiting_on] ?? d.waiting_on}
                      </span>
                    ) : null
                  }
                  empty="不等谁"
                />
                <Attr label="负责人" mono value={d.owner} empty="未认领" />
                <Attr label="模块" value={d.epic} />
                <Attr label="决策文档" mono value={d.adr} />
                <Attr label="时间" value={times} />
              </SettingsCard>
              <SettingsCard className="detail-attribute-group detail-long-attributes">
                <p className="attribute-heading">关系</p>
                {L?.split_from && (
                  <Attr
                    label="拆自"
                    value={<IdLink id={L.split_from} onSelect={onSelectTask} />}
                  />
                )}
                {L && L.split_out.length > 0 && (
                  <Attr
                    label="拆出"
                    value={<Ids ids={L.split_out} onSelect={onSelectTask} />}
                  />
                )}
                {L && L.supersedes.length > 0 && (
                  <Attr
                    label="替代了"
                    value={<Ids ids={L.supersedes} onSelect={onSelectTask} />}
                  />
                )}
                {L && L.superseded_by.length > 0 && (
                  <Attr
                    label="被替代"
                    value={
                      <Ids ids={L.superseded_by} onSelect={onSelectTask} />
                    }
                  />
                )}
                <Attr
                  label="修改范围"
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
                  label="引用"
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
