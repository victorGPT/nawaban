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

// 卡详情 = 左主内容(阅读主线)+ 右属性栏(一眼扫)。纯只读:面板是 agent 工作的**结果**,不是输入。
// 尺度取自 2026-09-07 在 linear.app 真 issue 页 DOM 量到的值:
//   标题 24/32 600 · 正文 15/24 · UI 13 500 · 属性行 28px、图标+值、无标签(标签进 title) · 组间距 40
//   文字三档:foreground / fg-secondary(属性值) / muted-foreground(组标题·空占位·时间)
//   主栏 ~594 · 右栏 300 · section 间只有发丝线 · 列表项无卡片边框 · 空值 = 动词占位
const FOLD = 3; // 右栏长列表默认露几条;活动流默认 5 条

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
  return (
    <button
      className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          setTimeout(() => setOk(false), 1200);
        });
      }}
      title={`复制 ${text}`}
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
          {all ? "收起" : `还有 ${items.length - n} 条`}
        </button>
      )}
    </>
  );
}

// 长正文默认 3 行,点开展开 —— 活动流不该被单条 note 撑成一页
function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      className={cn("block w-full cursor-pointer text-left", !open && "line-clamp-3")}
      onClick={() => setOpen((v) => !v)}
      title={open ? "收起" : "展开"}
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

// ── 活动 = events + sessions 按时间合流;session 是粗一级的里程碑(开工 / 收尾 + summary)──
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
                    {k.phase === "start" ? "开工" : `收尾 · ${k.s.outcome ?? "?"}`} · {rel(k.t)}
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
                <span className="text-fg-secondary">信</span>{" "}
                <span className="font-medium">{k.l.kind}</span>
                {!k.l.read_at && <span className="ml-1 text-warn-foreground">未读</span>} · {rel(k.t)}
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

// ── 右栏属性行:图标 + 值,无标签(hover 见);空值 = 三级色动词占位 ──
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
        {isEmpty ? (empty ?? `无 ${label}`) : value}
      </span>
    </div>
  );
}

function ResumeBlock({ s }: { s: TaskSession }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <TerminalSquare className="size-3.5 shrink-0" />
        <span className="truncate">{s.owner} · {s.outcome ?? "进行中"}</span>
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
  // 验收证据是拍板要读的正文(常为数 KB markdown),进主栏;pr/merge_sha 这类短指针留右栏
  const acceptance = d?.refs.filter((r) => r.kind === "acceptance_run") ?? [];
  const shortRefs = d?.refs.filter((r) => r.kind !== "acceptance_run") ?? [];
  const times = d
    ? [`创建 ${rel(d.created_at)}`, d.started_at && `开工 ${rel(d.started_at)}`, d.completed_at && `完成 ${rel(d.completed_at)}`]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <Sheet onOpenChange={onOpenChange} open={taskId != null}>
      <SheetContent className="w-full gap-0 overflow-y-auto p-0 sm:max-w-[1000px]">
        {!d && <SheetTitle className="sr-only">{taskId}</SheetTitle>}
        {error && <p className="p-6 text-destructive">加载失败:{error}</p>}
        {!d && !error && <p className="p-6 text-muted-foreground">加载中…</p>}
        {d && (
          <div className="flex min-h-full flex-col">
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-b px-4 text-ui text-muted-foreground">
              <span>{d.epic ?? "无 epic"}</span>
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
                    <H>来由</H>
                    <Md className="text-sm" text={d.context} />
                  </section>
                )}

                {(d.success?.length || d.constraints?.length) ? (
                  <section className="grid gap-6 md:grid-cols-2">
                    {d.success && d.success.length > 0 && (
                      <div>
                        <H n={d.success.length}>成功判据</H>
                        <Bullets items={d.success} />
                      </div>
                    )}
                    {d.constraints && d.constraints.length > 0 && (
                      <div>
                        <H n={d.constraints.length}>约束</H>
                        <Bullets items={d.constraints} />
                      </div>
                    )}
                  </section>
                ) : null}

                {kin && kin.blocked_by.length > 0 && (
                  <section>
                    <H n={kin.blocked_by.length}>被挡</H>
                    <p className="mb-2 text-xs text-muted-foreground">
                      真正卡在 <IdLink id={kin.stuck_at!} onSelect={onSelectTask} />
                    </p>
                    <div className="flex flex-col divide-y">
                      {kin.blocked_by.map((t) => (
                        <div className="py-2 text-sm" key={t.id} style={{ marginLeft: (t.depth - 1) * 12 }}>
                          <IdLink id={t.id} onSelect={onSelectTask} />
                          <span className="ml-2 text-xs text-muted-foreground">{t.status}</span>
                          <p className="mt-0.5 text-xs">{t.title}</p>
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
                        <div className="py-2 text-sm" key={t.id}>
                          <IdLink id={t.id} onSelect={onSelectTask} />
                          <span className="ml-2 text-xs text-muted-foreground">{t.status}</span>
                          <p className="mt-0.5 text-xs">{t.title}</p>
                          {t.others_waiting > 0 && (
                            <p className="text-xs text-muted-foreground">另有 {t.others_waiting} 张还在等别人</p>
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
                                  <li key={i}>否:<Md inline text={r} /></li>
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
                    <H n={acceptance.length}>验收证据</H>
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
                  <H n={d.events.length + d.sessions.length + (d.letters?.length ?? 0)}>活动</H>
                  <Timeline d={d} />
                </section>
              </main>

              <aside className="flex flex-col gap-10 px-6 pt-12 pb-10">
                {d.sessions[0] && <ResumeBlock s={d.sessions[0]} />}
                <div>
                  <p className="mb-2 text-ui font-medium text-muted-foreground">属性</p>
                  <Attr icon={Circle} label="状态" value={d.status} />
                  <Attr icon={Hourglass} label="等" value={d.waiting_on ? <span className="text-warn-foreground">等 {d.waiting_on}</span> : null} empty="不等谁" />
                  <Attr icon={User} label="owner" mono value={d.owner} empty="未认领" />
                  <Attr icon={Layers} label="epic" value={d.epic} />
                  <Attr icon={BookOpen} label="adr" value={d.adr} />
                  <Attr icon={Clock} label="时间" value={times} />
                </div>
                <div>
                  <p className="mb-2 text-ui font-medium text-muted-foreground">关系</p>
                  {L?.split_from && <Attr icon={GitFork} label="拆自" value={<IdLink id={L.split_from} onSelect={onSelectTask} />} />}
                  {L && L.split_out.length > 0 && <Attr icon={GitFork} label="拆出" value={<Ids ids={L.split_out} onSelect={onSelectTask} />} />}
                  {L && L.supersedes.length > 0 && <Attr icon={GitFork} label="替代了" value={<Ids ids={L.supersedes} onSelect={onSelectTask} />} />}
                  {L && L.superseded_by.length > 0 && <Attr icon={GitFork} label="被替代" value={<Ids ids={L.superseded_by} onSelect={onSelectTask} />} />}
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
                    label="引用"
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
