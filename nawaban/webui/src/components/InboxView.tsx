import { t, type TranslationKey } from "@/i18n";
import zhCN from "@/i18n/zh-CN.json";
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

// Persist the existing verdict and supplement marker regardless of display language.
const ACCEPT_VERDICT = zhCN.acceptVerdict;
const KIND_LABEL: Record<string, TranslationKey> = { authorize: "approval", accept: "acceptance", decide: "decision" };
const KIND_ACTION_LABEL: Record<string, TranslationKey> = { authorize: "approve", accept: "acknowledge", decide: "confirmDecision" };

type OptionItem = { option: string; consequence?: string };

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
  if (kind === "accept") return <Badge variant="warn">{t(KIND_LABEL.accept)}</Badge>;
  if (kind === "decide") return <Badge variant="destructive">{t(KIND_LABEL.decide)}</Badge>;

  return (
    <Badge className="border-[#5e6ad2] text-[#5e6ad2]" variant="outline">
      {t(KIND_LABEL.authorize)}
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

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [supplement, setSupplement] = useState("");
  const [otherText, setOtherText] = useState("");

  async function submit(verdict: string, reject: boolean, close: () => void = () => {}) {
    setBusy(true);
    setError(null);
    try {
      const r = await postAnswer(ask.id, verdict, reject);
      toast.success(t("resolvedAsk", { id: ask.id }), { description: r.out || undefined });
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

  const displayOptions = isDecide && options ? [...options, { option: t("other") }] : (options ?? []);
  const otherIndex = displayOptions.length - 1;
  const isOtherSelected = isDecide && selectedIdx === otherIndex;
  const decideVerdict =
    selectedIdx == null
      ? ""
      : isOtherSelected
        ? otherText.trim()
        : supplement.trim()
          ? `${displayOptions[selectedIdx].option}${zhCN.supplementMarker}${supplement.trim()}`
          : displayOptions[selectedIdx].option;

  return (
    <Card className="gap-2.5 rounded-md py-3">
      <CardHeader className="gap-1.5 px-3">
        <div className="flex items-center gap-2">
          <KindBadge kind={ask.kind} />
          <span className="font-mono text-xs text-muted-foreground">#{ask.id}</span>
          {ask.hands_on && <Badge variant="warn">{t("handsOn")}</Badge>}
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
                  placeholder={t("answerPlaceholder")}
                  value={otherText}
                />
              ) : (
                selectedIdx != null && (
                  <Textarea
                    onChange={(e) => setSupplement(e.target.value)}
                    placeholder={t("supplement")}
                    value={supplement}
                  />
                )
              ))}
          </>
        )}
        {ask.kind === "authorize" && (
          <p className="rounded-md border border-[#fbbf24]/40 bg-[#3a2f16] p-2 text-xs leading-relaxed text-[#fbbf24]">
            {t("approvalRecords")}<b>{t("notAutomatic")}</b>{t("afterExecution")}
            <code className="text-foreground">nawaban fanout {ask.id} --ok</code>{t("failedFlag")}
          </p>
        )}
        {ask.evidence && (
          <p className="max-h-44 overflow-auto rounded-md bg-muted p-2 font-mono text-[11.5px] break-words whitespace-pre-wrap text-muted-foreground">
            {ask.evidence}
          </p>
        )}
        {ask.confidence != null && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{t("confidence", { percent: Math.round(ask.confidence * 100) })}</span>
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
              {t("requestChanges")}
            </Button>
            <Button disabled={busy} onClick={() => submit(ACCEPT_VERDICT, false)} size="sm">
              {t("acknowledge")}
            </Button>
          </>
        ) : isDecide && hasOptions ? (
          <Button
            disabled={busy || !decideVerdict}
            onClick={() => submit(decideVerdict, false, resetDecide)}
            size="sm"
            title={selectedIdx == null ? t("selectOption") : undefined}
          >
            {t(KIND_ACTION_LABEL.decide)}
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => setDialog({ reject: false })} size="sm">
            {t(KIND_ACTION_LABEL[ask.kind] ?? "answer")}
          </Button>
        )}
      </CardFooter>

      <Dialog onOpenChange={(open) => !open && setDialog(null)} open={dialog != null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.reject ? t("requestChanges") : t(KIND_ACTION_LABEL[ask.kind] ?? "answer")} #{ask.id}
            </DialogTitle>
          </DialogHeader>
          <Textarea
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={(dialog?.reject ? t("rejectReason") : t("answer")) + t("recordedVerbatim")}
            value={answer}
          />
          <DialogFooter>
            <Button disabled={busy} onClick={() => setDialog(null)} variant="outline">
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !answer.trim()}
              onClick={() => submit(answer.trim(), dialog?.reject ?? false, () => setDialog(null))}
            >
              {t("submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function copyReopen(id: string) {
  const cmd = `nawaban reopen ${id} --reason "..."`;
  navigator.clipboard
    .writeText(cmd)
    .then(() => toast.success(t("copied"), { description: cmd }))
    .catch(() => toast.error(t("copyFailed")));
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
        <code className="rounded bg-muted px-1.5 py-0.5">nawaban reopen {r.id} --reason "..."</code>
        <Button className="h-5 px-2 text-[10px]" onClick={() => copyReopen(r.id)} size="sm" variant="outline">
          {t("copy")}
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
        {t("selfApproved", { count: items.length, lane: lane.length, silent: silent ? t("silentCount", { count: silent }) : "" })}
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-1.5">
        {lane.map((r) => (
          <SelfApprovedRow key={r.id} r={r} />
        ))}
      </div>
      {silent > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("silentTasks", { count: silent })}
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

  const selected = flat.find((a) => a.id === selectedId) ?? flat[0] ?? null;

  if (error) return <p className="p-4 text-sm text-destructive">{t("inboxError")}{error}</p>;
  if (!data) return <p className="p-4 text-sm text-muted-foreground">{t("loading")}</p>;

  return (
    <div className="grid h-full grid-cols-[400px_minmax(0,1fr)]">
      <ScrollArea className="border-r">
        <div className="flex h-9 items-center px-4 text-xs text-muted-foreground">
          {data.total ? t("inboxPending", { count: data.total, days: data.oldest_days }) : t("inboxEmptyDecision")}{t("inboxFlow", { raised: data.flow.raised_7d, closed: data.flow.closed_7d })}
        </div>
        {groups.map((g) => (
          <section key={g.kind}>
            <h2 className="flex h-7 items-center bg-panel px-4 text-xs font-medium text-muted-foreground">
              {t(KIND_LABEL[g.kind])} <span className="ml-1.5 font-normal">{g.items.length}</span>
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
                    {t(KIND_LABEL[a.kind])}
                  </span>
                  <span className="font-mono">#{a.id}</span>
                  {a.hands_on && <span className="text-warn-foreground">{t("handsOn")}</span>}
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
          <p className="p-8 text-sm text-muted-foreground">{flat.length ? t("selectDetails") : t("inboxEmpty")}</p>
        )}
      </ScrollArea>
    </div>
  );
}
