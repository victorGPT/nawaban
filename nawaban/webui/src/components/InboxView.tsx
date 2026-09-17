import { t, useLocale, type TranslationKey } from "@/i18n";
import zhCN from "@/i18n/zh-CN.json";
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

// Persist the established verdict and supplement marker independently of display locale.
const ACCEPT_VERDICT = zhCN.acceptVerdict;
const KIND_LABEL: Record<string, TranslationKey> = {
  authorize: "approval",
  accept: "acceptance",
  decide: "decision",
};
const KIND_ACTION_LABEL: Record<string, TranslationKey> = {
  authorize: "approve",
  accept: "acknowledge",
  decide: "confirmDecision",
};

type OptionItem = { option: string; consequence?: string };

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
  useLocale();
  if (onSelect)
    return (
      <RadioGroup
        aria-label={t("decisionOptions")}
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
  useLocale();
  return (
    <Chip
      color={
        kind === "accept" ? "yellow" : kind === "decide" ? "purple" : "blue"
      }
      variant="bold"
    >
      {KIND_LABEL[kind] ? t(KIND_LABEL[kind]) : kind}
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
  useLocale();
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
      notice(t("resolvedAsk", { id: ask.id }), "success", r.out || undefined);
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
    isDecide && options ? [...options, { option: t("other") }] : (options ?? []);
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
    <Surface className="ask-card">
      <header className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge kind={ask.kind} />
          <span className="text-body-regular text-text-secondary">
            #{ask.id}
          </span>
          {ask.hands_on && (
            <Chip color="yellow" variant="bold">
              {t("handsOn")}
            </Chip>
          )}
          <span className="ml-auto shrink-0 text-body-regular text-text-secondary">
            {t("waitingDays", { days: ask.stalled_days })}
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
                  aria-label={t("otherDecision")}
                  onChange={setOtherText}
                  placeholder={t("answerPlaceholder")}
                  value={otherText}
                />
              ) : (
                selectedIdx != null && (
                  <Textarea
                    aria-label={t("supplementDetails")}
                    onChange={setSupplement}
                    placeholder={t("supplement")}
                    value={supplement}
                  />
                )
              ))}
          </>
        )}
        {ask.kind === "authorize" && (
          <p className="text-body-regular text-text-secondary">
            {t("authorizeExecutionNotice")}
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
              {t("confidence", { percent: Math.round(ask.confidence * 100) })}
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
            {unknown ? t("unknownAnswer") : error}
          </p>
        )}
        {unknown && (
          <Button variant="secondary" onClick={onDone}>
            {t("verifyAnswerResult")}
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
              {t("requestChanges")}
            </Button>
            <Button
              disabled={unknown || busy}
              onClick={() => submit(ACCEPT_VERDICT, false)}
              size="small"
            >
              {t("acknowledge")}
            </Button>
          </>
        ) : isDecide && hasOptions ? (
          <Button
            disabled={unknown || busy || !decideVerdict}
            onClick={() => submit(decideVerdict, false, resetDecide)}
            size="small"
            title={selectedIdx == null ? t("selectOption") : undefined}
          >
            {t(KIND_ACTION_LABEL.decide)}
          </Button>
        ) : (
          <Button
            disabled={unknown || busy}
            onClick={() => setDialog({ reject: false })}
            size="small"
          >
            {t(KIND_ACTION_LABEL[ask.kind] ?? "answer")}
          </Button>
        )}
      </footer>

      {/* Rejection, authorization and decisions without predefined choices use a dialog. */}
      <NawabanDialog
        open={dialog != null}
        onClose={() => !busy && setDialog(null)}
        title={`${dialog?.reject ? t("requestChanges") : t(KIND_ACTION_LABEL[ask.kind] ?? "answer")} #${ask.id}`}
      >
        <div className="answer-form">
          <Textarea
            aria-label={dialog?.reject ? t("rejectReason") : t("answer")}
            onChange={setAnswer}
            placeholder={
              (dialog?.reject ? t("rejectReason") : t("answer")) + t("recordedVerbatim")
            }
            value={answer}
          />
          <footer className="answer-actions">
            <Button
              disabled={unknown || busy}
              onClick={() => setDialog(null)}
              variant="secondary"
            >
              {t("cancel")}
            </Button>
            <Button
              disabled={unknown || busy || !answer.trim()}
              onClick={() =>
                submit(answer.trim(), dialog?.reject ?? false, () =>
                  setDialog(null),
                )
              }
            >
              {t("submit")}
            </Button>
          </footer>
          {error && (
            <p role="alert" className="text-text-error-primary">
              {unknown ? t("unknownAnswer") : error}
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
    .then(() => notice(t("copied"), "success", cmd))
    .catch(() => notice(t("copyFailed"), "error"));
}

function SelfApprovedRow({ r }: { r: SelfApproved }) {
  useLocale();
  const notice = useNotice();
  return (
    <Surface className="inbox-history-row min-w-0 text-body-regular">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-text-secondary">{r.id}</span>
        <span className="shrink-0 text-text-secondary">
          {t("elapsedAgo", { time: ago(r.completed_at) })}
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
          {t("copyCommand")}
        </LinkButton>
      </div>
    </Surface>
  );
}

function SelfApprovedDigest({ items }: { items: SelfApproved[] }) {
  useLocale();
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
          {t("selfApprovedTitle", { count: items.length })}
        </span>
        <span className="text-body-regular text-text-secondary">
          {t("selfApprovedCounts", { count: lane.length, other: silent ? t("otherTaskCount", { count: silent }) : "" })}
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
              {t("selfApprovedRemainder", { count: silent })}
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
        {groups.map((g) => (
          <section key={g.kind}>
            <h2 className="flex items-center px-4 py-2 text-body-medium text-text-secondary">
              {KIND_LABEL[g.kind] ? t(KIND_LABEL[g.kind]) : g.title}{" "}
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
                      {t("handsOn")}
                    </Chip>
                  )}
                  <span className="ml-auto">{t("daysCount", { days: a.stalled_days })}</span>
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
                  <AskCard ask={a} onDone={load} onSelectTask={onSelectTask} />
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
