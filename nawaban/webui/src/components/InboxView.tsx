import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Md } from "@/components/Md";
import { Chip } from "@/components/base/badges/chip";
import { LinkButton } from "@/components/base/buttons/link-button";
import { Button } from "@/components/base/buttons/button";
import { Textarea } from "@/components/base/textarea/textarea";
import { RadioGroup } from "@/components/base/radio/radio";
import { RadioCard } from "@/components/base/radio/radio-card";
import {
  ContentButton,
  Surface,
  NawabanDialog,
  LoadState,
  useNotice,
} from "@/components/NawabanUI";
import { inboxMatches } from "@/lib/nawaban-model";
import { fetchInbox, postAnswer, AnswerError, type Project } from "@/lib/api";
import { ago, cn } from "@/lib/utils";
import type { AskItem, InboxResponse, SelfApproved } from "@/lib/types";

// Presentation only; answer authority and draft lifecycle follow the existing API.

const ACCEPT_VERDICT = "验收通过(收件箱一键)";
const KIND_LABEL: Record<string, string> = {
  authorize: "放行",
  accept: "验收",
  decide: "拍板",
};
const KIND_ACTION_LABEL: Record<string, string> = {
  authorize: "授权",
  accept: "收下",
  decide: "就这么定",
};

type OptionItem = { option: string; consequence?: string };
const OTHER_OPTION: OptionItem = { option: "其他…" };

// Shared option presentation; onSelect enables interactive selection.
function OptionsList({
  options,
  selectedIndex,
  onSelect,
}: {
  options: OptionItem[];
  selectedIndex?: number | null;
  onSelect?: (i: number) => void;
}) {
  if (onSelect)
    return (
      <RadioGroup
        aria-label="决策选项"
        value={selectedIndex == null ? "" : String(selectedIndex)}
        onChange={(value) => onSelect(Number(value))}
        className="decision-options"
      >
        {options.map((o, i) => (
          <RadioCard
            key={i}
            value={String(i)}
            title={<Md text={o.option} />}
            description={o.consequence && <Md text={o.consequence} />}
          />
        ))}
      </RadioGroup>
    );
  return (
    <div className="decision-options">
      {options.map((o, i) => (
        <Surface className="inbox-option" key={i}>
          <Md text={o.option} />
          {o.consequence && <Md text={o.consequence} />}
        </Surface>
      ))}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <Chip
      color={
        kind === "accept" ? "yellow" : kind === "decide" ? "purple" : "blue"
      }
      variant="bold"
    >
      {KIND_LABEL[kind] ?? kind}
    </Chip>
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
  const notice = useNotice();
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ reject: boolean } | null>(null);
  const [answer, setAnswer] = useState("");

  // Decision choices are selected and submitted directly on the card.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [supplement, setSupplement] = useState("");
  const [otherText, setOtherText] = useState("");

  async function submit(
    verdict: string,
    reject: boolean,
    close: () => void = () => {},
  ) {
    if (busy || unknown) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postAnswer(ask.id, verdict, reject);
      notice(`#${ask.id} 已处理`, "success", r.out || undefined);
      close();
      onDone();
    } catch (e) {
      if (e instanceof AnswerError && e.unknown) setUnknown(true);
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
  const options = Array.isArray(ask.options)
    ? (ask.options as OptionItem[])
    : null;
  const hasOptions = options != null && options.length > 0;
  const isDecide = ask.kind === "decide";
  // Decision cards include a free-text choice; other kinds render read-only options.
  const displayOptions =
    isDecide && options ? [...options, OTHER_OPTION] : (options ?? []);
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
    <Surface className="ask-card">
      <header className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={ask.kind} />
          <span className="text-body-regular text-text-secondary">
            #{ask.id}
          </span>
          {ask.hands_on && (
            <Chip color="yellow" variant="bold">
              需要你亲自操作
            </Chip>
          )}
          <span className="ml-auto shrink-0 text-body-regular text-text-secondary">
            等待 {ask.stalled_days} 天
          </span>
        </div>
        <div className="text-body-medium">
          <Md className="detail-subheading" text={ask.question} />
        </div>
      </header>

      <div className="flex flex-col gap-4">
        {blast && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-regular">
            {Object.entries(blast).map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-text-secondary">{k}</dt>
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
                  aria-label="其他决策"
                  onChange={setOtherText}
                  placeholder="回答(会原样进决策记录)"
                  value={otherText}
                />
              ) : (
                selectedIdx != null && (
                  <Textarea
                    aria-label="补充说明"
                    onChange={setSupplement}
                    placeholder="补充说明(非必填)"
                    value={supplement}
                  />
                )
              ))}
          </>
        )}
        {ask.kind === "authorize" && (
          <p className="text-body-regular text-text-secondary">
            授权只记录你的决定，操作仍需由 Agent 执行并回报结果。
          </p>
        )}
        {ask.evidence && (
          <p className="max-h-44 overflow-auto text-body-regular break-words whitespace-pre-wrap text-text-secondary">
            {ask.evidence}
          </p>
        )}
        {ask.confidence != null && (
          <p className="text-body-regular text-text-secondary">
            <span className="text-body-regular text-text-primary">
              {Math.round(ask.confidence * 100)}% 把握
            </span>
            {ask.confidence_reason ? ` · ${ask.confidence_reason}` : ""}
          </p>
        )}
        {ask.task_ids.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {ask.task_ids.map((id) => (
              <LinkButton
                key={id}
                className="detail-code-link"
                onClick={() => onSelectTask(id)}
              >
                <Chip
                  color="soft"
                  variant="bold"
                  className="whitespace-normal break-words text-left"
                >
                  {id}
                </Chip>
              </LinkButton>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-body-regular text-text-error-primary">
            {error}
          </p>
        )}
        {unknown && (
          <Button variant="secondary" onClick={onDone}>
            刷新收件箱，核对处理结果
          </Button>
        )}
      </div>

      <footer className="justify-end gap-2">
        {ask.kind === "accept" ? (
          <>
            <Button
              disabled={unknown || busy}
              onClick={() => setDialog({ reject: true })}
              size="small"
              variant="secondary"
            >
              打回
            </Button>
            <Button
              disabled={unknown || busy}
              onClick={() => submit(ACCEPT_VERDICT, false)}
              size="small"
            >
              收下
            </Button>
          </>
        ) : isDecide && hasOptions ? (
          <Button
            disabled={unknown || busy || !decideVerdict}
            onClick={() => submit(decideVerdict, false, resetDecide)}
            size="small"
            title={selectedIdx == null ? "先选一个选项" : undefined}
          >
            {KIND_ACTION_LABEL.decide}
          </Button>
        ) : (
          <Button
            disabled={unknown || busy}
            onClick={() => setDialog({ reject: false })}
            size="small"
          >
            {KIND_ACTION_LABEL[ask.kind] ?? "回答"}
          </Button>
        )}
      </footer>

      {/* Rejection, authorization and decisions without predefined choices use a dialog. */}
      <NawabanDialog
        open={dialog != null}
        onClose={() => !busy && setDialog(null)}
        title={`${dialog?.reject ? "打回" : (KIND_ACTION_LABEL[ask.kind] ?? "回答")} #${ask.id}`}
      >
        <div className="answer-form">
          <Textarea
            aria-label={dialog?.reject ? "打回理由" : "回答"}
            onChange={setAnswer}
            placeholder={
              (dialog?.reject ? "打回理由" : "回答") + "(会原样进决策记录)"
            }
            value={answer}
          />
          <footer className="answer-actions">
            <Button
              disabled={unknown || busy}
              onClick={() => setDialog(null)}
              variant="secondary"
            >
              取消
            </Button>
            <Button
              disabled={unknown || busy || !answer.trim()}
              onClick={() =>
                submit(answer.trim(), dialog?.reject ?? false, () =>
                  setDialog(null),
                )
              }
            >
              提交
            </Button>
          </footer>
          {error && (
            <p role="alert" className="text-text-error-primary">
              {error}
            </p>
          )}
        </div>
      </NawabanDialog>
    </Surface>
  );
}

function copyReopen(id: string, notice: ReturnType<typeof useNotice>) {
  const cmd = `nawaban reopen ${id} --reason "..."`;
  navigator.clipboard
    .writeText(cmd)
    .then(() => notice("已复制", "success", cmd))
    .catch(() => notice("复制失败,手动选中吧", "error"));
}

function SelfApprovedRow({ r }: { r: SelfApproved }) {
  const notice = useNotice();
  return (
    <Surface className="inbox-history-row min-w-0 text-body-regular">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-text-secondary">{r.id}</span>
        <span className="shrink-0 text-text-secondary">
          {ago(r.completed_at)} ago
        </span>
      </div>
      <p className="break-words text-text-primary">{r.title}</p>
      {r.evidence && (
        <p className="break-words text-text-secondary">
          {r.evidence.slice(0, 160)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <code className="break-all text-body-regular">
          nawaban reopen {r.id} --reason "..."
        </code>
        <LinkButton
          className="detail-action"
          onClick={() => copyReopen(r.id, notice)}
          variant="secondary"
        >
          复制命令
        </LinkButton>
      </div>
    </Surface>
  );
}

function SelfApprovedDigest({ items }: { items: SelfApproved[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const lane = items.filter((r) => r.self_evident);
  const silent = items.length - lane.length;
  return (
    <Surface className="inbox-summary">
      <ContentButton
        className="inbox-summary-toggle text-body-regular"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="text-body-medium">
          自动归档 · 近 7 天 {items.length} 张
        </span>
        <span className="text-body-regular text-text-secondary">
          可核对 {lane.length} 张{silent ? ` · 其他 ${silent} 张` : ""}
        </span>
      </ContentButton>
      {expanded && (
        <>
          <div className="mt-2 flex min-w-0 flex-col gap-1.5">
            {lane.map((r) => (
              <SelfApprovedRow key={r.id} r={r} />
            ))}
          </div>
          {silent > 0 && (
            <p className="mt-2 text-body-regular text-text-secondary">
              其余 {silent} 张由其他自动流程归档。
            </p>
          )}
        </>
      )}
    </Surface>
  );
}

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
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
          setError("收件箱数据当前不可用");
          return;
        }
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (active.current && version === requestVersion.current) setError(String(e));
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

  if (error && !data) return <LoadState error>{error}</LoadState>;
  if (!data) return <LoadState>正在读取收件箱…</LoadState>;

  return (
    <div className="inbox-layout">
      <div className="inbox-index">
        <div className="px-4 py-4 text-body-regular text-text-secondary">
          {data.total
            ? `${data.total} 件事等你 · 最久停了 ${data.oldest_days} 天`
            : "没有需要你决定的事"}{" "}
          · 本周进 {data.flow.raised_7d} · 已清 {data.flow.closed_7d}
        </div>
        {groups.map((g) => (
          <section key={g.kind}>
            <h2 className="flex items-center px-4 py-2 text-body-medium text-text-secondary">
              {g.title}{" "}
              <span className="ml-2 text-body-regular">{g.items.length}</span>
            </h2>
            {g.items.map((a) => (
              <ContentButton
                className={cn(
                  "inbox-item w-full border-b px-4 py-3 text-left transition-colors",
                  selected?.id === a.id
                    ? "bg-background-secondary-hover"
                    : "hover:bg-background-secondary-hover/40",
                )}
                key={a.id}
                aria-current={selected?.id === a.id ? "true" : undefined}
                onClick={() => setSelectedId(a.id)}
                type="button"
              >
                <div className="flex flex-wrap items-center gap-2 text-body-regular text-text-secondary">
                  <KindBadge kind={a.kind} />
                  <span className="text-body-regular">#{a.id}</span>
                  {a.hands_on && (
                    <Chip color="yellow" variant="bold">
                      需亲自操作
                    </Chip>
                  )}
                  <span className="ml-auto">{a.stalled_days} 天</span>
                </div>
                <p className="line-clamp-2 text-body-regular text-text-primary">
                  {a.question}
                </p>
              </ContentButton>
            ))}
          </section>
        ))}
        {data.self_approved && data.self_approved.length > 0 && (
          <div className="p-3">
            <SelfApprovedDigest items={data.self_approved} />
          </div>
        )}
      </div>

      <div className="inbox-detail">
        {error && <LoadState error>刷新失败，保留当前草稿：{error}</LoadState>}
        {data.groups.some((g) => g.items.length > 0) && (
          <div
            className="inbox-reading mx-auto max-w-2xl p-6"
            hidden={!selected}
          >
            {data.groups
              .flatMap((g) => g.items)
              .map((a) => (
                <div hidden={a.id !== selected?.id} key={a.id}>
                  <AskCard ask={a} onDone={load} onSelectTask={onSelectTask} />
                </div>
              ))}
          </div>
        )}
        {!selected && (
          <p className="p-8 text-body-regular text-text-secondary">
            {q ? "没有匹配的待处理事项" : "收件箱是空的"}
          </p>
        )}
      </div>
    </div>
  );
}
