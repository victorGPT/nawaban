import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Md } from "@/components/Md";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { fetchInbox, postAnswer } from "@/lib/api";
import { ago, cn } from "@/lib/utils";
import type { AskItem, InboxResponse, SelfApproved } from "@/lib/types";

// 字段与交互对齐 ~/.claude/foreman/workos/board_view.py INBOX_PAGE 的 askHTML()/submit()
// (旧板逐条验证过的形态,本轮只重做视觉层,不碰字段/逻辑)。
// 布局按 Linear inbox(2026-09-07 真页量):左 400px 列表(种类 · 问题 13/500 · 停了几天 12 三级色 ·
// 半像素分隔线)+ 右栏当前条目的完整卡(AskCard 原封不动)。列表是索引,右栏是重点。

const ACCEPT_VERDICT = "验收通过(收件箱一键)";
const KIND_LABEL: Record<string, string> = { authorize: "放行", accept: "验收", decide: "拍板" };
const KIND_ACTION_LABEL: Record<string, string> = { authorize: "授权", accept: "收下", decide: "就这么定" };

type OptionItem = { option: string; consequence?: string };
const OTHER_OPTION: OptionItem = { option: "其他…" };

// Card 正文的只读展示、Dialog 里的单选选择,共用同一份渲染——只是要不要给 onSelect。
function OptionsList({
  options,
  selectedIndex,
  onSelect,
}: {
  options: OptionItem[];
  selectedIndex?: number | null;
  onSelect?: (i: number) => void;
}) {
  return (
    <ul className="divide-y divide-border rounded-md border text-xs">
      {options.map((o, i) => {
        const body = (
          <>
            <Md className="font-medium" text={o.option} />
            {o.consequence && <Md className="text-muted-foreground" text={o.consequence} />}
          </>
        );
        if (!onSelect) {
          return (
            <li className="flex flex-col gap-0.5 p-2" key={i}>
              {body}
            </li>
          );
        }
        return (
          <li key={i}>
            <button
              className={cn(
                "flex w-full flex-col gap-0.5 p-2 text-left transition-colors",
                selectedIndex === i
                  ? "bg-[#5e6ad2]/15 ring-1 ring-[#5e6ad2] ring-inset"
                  : "hover:bg-accent/60"
              )}
              onClick={() => onSelect(i)}
              type="button"
            >
              {body}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function KindBadge({ kind }: { kind: string }) {
  if (kind === "accept") return <Badge variant="warn">{KIND_LABEL.accept}</Badge>;
  if (kind === "decide") return <Badge variant="destructive">{KIND_LABEL.decide}</Badge>;
  // 放行 = accent 描边,不是我们已有的任何 badge variant(那些都是"完成态"语义)——
  // 直接复用 ModulesView 专注模式同一个 accent 色号(#5e6ad2),别再造一个新色。
  return (
    <Badge className="border-[#5e6ad2] text-[#5e6ad2]" variant="outline">
      {KIND_LABEL.authorize}
    </Badge>
  );
}

function AskCard({
  ask,
  onDone,
  onSelectTask,
}: {
  ask: AskItem;
  onDone: () => void;
  onSelectTask: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ reject: boolean } | null>(null);
  const [answer, setAnswer] = useState("");

  // decide 类的选项式提交,就地在卡面上选(拍板是选择题,不是默写题——不再弹 Dialog)。
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [supplement, setSupplement] = useState("");
  const [otherText, setOtherText] = useState("");

  async function submit(verdict: string, reject: boolean, close: () => void = () => {}) {
    setBusy(true);
    setError(null);
    try {
      const r = await postAnswer(ask.id, verdict, reject);
      toast.success(`#${ask.id} 已处理`, { description: r.out || undefined });
      close();
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function resetDecide() {
    setSelectedIdx(null);
    setSupplement("");
    setOtherText("");
  }

  const blast =
    ask.blast && typeof ask.blast === "object" && !Array.isArray(ask.blast)
      ? (ask.blast as Record<string, string>)
      : null;
  const options = Array.isArray(ask.options) ? (ask.options as OptionItem[]) : null;
  const hasOptions = options != null && options.length > 0;
  const isDecide = ask.kind === "decide";
  // decide 卡面可点选,末尾补一个「其他…」兜底;别的 kind(理论上不会有 options)照原样只读展示。
  const displayOptions = isDecide && options ? [...options, OTHER_OPTION] : (options ?? []);
  const otherIndex = displayOptions.length - 1;
  const isOtherSelected = isDecide && selectedIdx === otherIndex;
  const decideVerdict =
    selectedIdx == null
      ? ""
      : isOtherSelected
        ? otherText.trim()
        : supplement.trim()
          ? `${displayOptions[selectedIdx].option} · 补充:${supplement.trim()}`
          : displayOptions[selectedIdx].option;

  return (
    <Card className="gap-2.5 rounded-md py-3">
      <CardHeader className="gap-1.5 px-3">
        <div className="flex items-center gap-2">
          <KindBadge kind={ask.kind} />
          <span className="font-mono text-xs text-muted-foreground">#{ask.id}</span>
          {ask.hands_on && <Badge variant="warn">要你亲自点</Badge>}
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {ask.stalled_days}d
          </span>
        </div>
        <CardTitle className="text-sm leading-snug font-medium"><Md text={ask.question} /></CardTitle>
      </CardHeader>

      <CardContent className="flex flex-col gap-2.5 px-3">
        {blast && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {Object.entries(blast).map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-muted-foreground">{k}</dt>
                <dd>{String(v)}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {hasOptions && (
          <>
            <OptionsList
              onSelect={isDecide ? setSelectedIdx : undefined}
              options={displayOptions}
              selectedIndex={selectedIdx}
            />
            {isDecide &&
              (isOtherSelected ? (
                <Textarea
                  onChange={(e) => setOtherText(e.target.value)}
                  placeholder="回答(会原样进决策记录)"
                  value={otherText}
                />
              ) : (
                selectedIdx != null && (
                  <Textarea
                    onChange={(e) => setSupplement(e.target.value)}
                    placeholder="补充说明(非必填)"
                    value={supplement}
                  />
                )
              ))}
          </>
        )}
        {ask.kind === "authorize" && (
          <p className="rounded-md border border-[#fbbf24]/40 bg-[#3a2f16] p-2 text-xs leading-relaxed text-[#fbbf24]">
            授权只记录你的决定 —— <b>不会自动执行</b>。动作真跑完之后再收口:
            <code className="text-foreground">workos fanout {ask.id} --ok</code>(失败用 --failed)
          </p>
        )}
        {ask.evidence && (
          <p className="max-h-44 overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] break-words whitespace-pre-wrap text-muted-foreground">
            {ask.evidence}
          </p>
        )}
        {ask.confidence != null && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{Math.round(ask.confidence * 100)}% 把握</span>
            {ask.confidence_reason ? ` · ${ask.confidence_reason}` : ""}
          </p>
        )}
        {ask.task_ids.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {ask.task_ids.map((id) => (
              <button key={id} onClick={() => onSelectTask(id)} type="button">
                <Badge
                  className="cursor-pointer font-mono text-[10px] hover:border-card-hover-border"
                  variant="secondary"
                >
                  {id}
                </Badge>
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>

      <CardFooter className="justify-end gap-2 px-3">
        {ask.kind === "accept" ? (
          <>
            <Button disabled={busy} onClick={() => setDialog({ reject: true })} size="sm" variant="outline">
              打回
            </Button>
            <Button disabled={busy} onClick={() => submit(ACCEPT_VERDICT, false)} size="sm">
              收下
            </Button>
          </>
        ) : isDecide && hasOptions ? (
          <Button
            disabled={busy || !decideVerdict}
            onClick={() => submit(decideVerdict, false, resetDecide)}
            size="sm"
            title={selectedIdx == null ? "先选一个选项" : undefined}
          >
            {KIND_ACTION_LABEL.decide}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => setDialog({ reject: false })} size="sm">
            {KIND_ACTION_LABEL[ask.kind] ?? "回答"}
          </Button>
        )}
      </CardFooter>

      {/* accept 的打回 + authorize 的自由回答 + decide 没有 options 时的兜底(卡面已经能选,不再需要单独的 decide Dialog) */}
      <Dialog onOpenChange={(open) => !open && setDialog(null)} open={dialog != null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.reject ? "打回" : KIND_ACTION_LABEL[ask.kind] ?? "回答"} #{ask.id}
            </DialogTitle>
          </DialogHeader>
          <Textarea
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={(dialog?.reject ? "打回理由" : "回答") + "(会原样进决策记录)"}
            value={answer}
          />
          <DialogFooter>
            <Button disabled={busy} onClick={() => setDialog(null)} variant="outline">
              取消
            </Button>
            <Button
              disabled={busy || !answer.trim()}
              onClick={() => submit(answer.trim(), dialog?.reject ?? false, () => setDialog(null))}
            >
              提交
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}


function copyReopen(id: string) {
  const cmd = `workos reopen ${id} --reason "..."`;
  navigator.clipboard
    .writeText(cmd)
    .then(() => toast.success("已复制", { description: cmd }))
    .catch(() => toast.error("复制失败,手动选中吧"));
}

function SelfApprovedRow({ r }: { r: SelfApproved }) {
  return (
    <Card className="min-w-0 gap-1 rounded-md p-2.5 text-xs">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-muted-foreground">{r.id}</span>
        <span className="shrink-0 text-muted-foreground">{ago(r.completed_at)} ago</span>
      </div>
      <p className="break-words text-foreground">{r.title}</p>
      {r.evidence && <p className="break-words text-muted-foreground">{r.evidence.slice(0, 160)}</p>}
      <div className="flex items-center gap-2 pt-0.5">
        <code className="rounded bg-muted px-1.5 py-0.5">workos reopen {r.id} --reason "..."</code>
        <Button className="h-5 px-2 text-[10px]" onClick={() => copyReopen(r.id)} size="sm" variant="outline">
          复制
        </Button>
      </div>
    </Card>
  );
}

function SelfApprovedDigest({ items }: { items: SelfApproved[] }) {
  if (items.length === 0) return null;
  const lane = items.filter((r) => r.self_evident);
  const silent = items.length - lane.length;
  return (
    <details className="rounded-md border bg-card p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        🤖 自批归档 digest · 近 7 天 {items.length} 张(自证 lane {lane.length} 条逐列
        {silent ? ` · 旧静默路 ${silent} 张计数压行` : ""} · 看着不对就打回)
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-1.5">
        {lane.map((r) => (
          <SelfApprovedRow key={r.id} r={r} />
        ))}
      </div>
      {silent > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          其余 {silent} 张经 prod/observe/external 路无人参与归档(历来如此)。
        </p>
      )}
    </details>
  );
}

function matches(a: AskItem, q: string) {
  const s = q.toLowerCase();
  return (
    String(a.id).includes(s) ||
    a.question.toLowerCase().includes(s) ||
    a.evidence.toLowerCase().includes(s)
  );
}

export function InboxView({
  query,
  onSelectTask,
}: {
  query: string;
  onSelectTask: (id: string) => void;
}) {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const load = () => {
    fetchInbox().then(setData).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const q = query.trim();
  const groups = useMemo(
    () =>
      (data?.groups ?? [])
        .map((g) => ({ ...g, items: q ? g.items.filter((a) => matches(a, q)) : g.items }))
        .filter((g) => g.items.length),
    [data, q]
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  // 选中项被处理掉 / 被搜索滤掉之后,退到列表第一条,别留一个空右栏。
  const selected = flat.find((a) => a.id === selectedId) ?? flat[0] ?? null;

  if (error) return <p className="p-4 text-sm text-destructive">收件箱加载失败:{error}</p>;
  if (!data) return <p className="p-4 text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="grid h-full grid-cols-[400px_minmax(0,1fr)]">
      <ScrollArea className="border-r">
        <div className="flex h-9 items-center px-4 text-xs text-muted-foreground">
          {data.total ? `${data.total} 件事等你 · 最久停了 ${data.oldest_days} 天` : "没有需要你决定的事"} · 本周进{" "}
          {data.flow.raised_7d} · 已清 {data.flow.closed_7d}
        </div>
        {groups.map((g) => (
          <section key={g.kind}>
            <h2 className="flex h-7 items-center bg-panel px-4 text-xs font-medium text-muted-foreground">
              {g.title} <span className="ml-1.5 font-normal">{g.items.length}</span>
            </h2>
            {g.items.map((a) => (
              <button
                className={cn(
                  "flex w-full flex-col gap-0.5 border-b px-4 py-2.5 text-left transition-colors",
                  selected?.id === a.id ? "bg-accent" : "hover:bg-accent/40"
                )}
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                type="button"
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn("font-medium", a.kind === "decide" && "text-destructive", a.kind === "accept" && "text-warn-foreground", a.kind === "authorize" && "text-[#5e6ad2]")}>
                    {KIND_LABEL[a.kind] ?? a.kind}
                  </span>
                  <span className="font-mono">#{a.id}</span>
                  {a.hands_on && <span className="text-warn-foreground">要你亲自点</span>}
                  <span className="ml-auto font-mono">{a.stalled_days}d</span>
                </div>
                <p className="line-clamp-2 text-ui font-medium text-fg-secondary">{a.question}</p>
              </button>
            ))}
          </section>
        ))}
        {data.self_approved && data.self_approved.length > 0 && (
          <div className="p-3">
            <SelfApprovedDigest items={data.self_approved} />
          </div>
        )}
      </ScrollArea>

      <ScrollArea className="h-full">
        {selected ? (
          <div className="mx-auto max-w-2xl px-8 py-8">
            {flat.map((a) => (
              <div hidden={a.id !== selected.id} key={a.id}>
                <AskCard ask={a} onDone={load} onSelectTask={onSelectTask} />
              </div>
            ))}
          </div>
        ) : (
          <p className="p-8 text-sm text-muted-foreground">{flat.length ? "选一条看详情" : "收件箱是空的"}</p>
        )}
      </ScrollArea>
    </div>
  );
}
