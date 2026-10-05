import { t, useLocale, type TranslationKey } from "@/i18n";
import zhCN from "@/i18n/zh-CN.json";
import { Fragment, useState } from "react";
import { KindBadge } from "@/components/inbox/KindBadge";
import { OptionsList, type OptionItem } from "@/components/inbox/OptionsList";
import { Md } from "@/components/Md";
import { Surface, NawabanDialog, useNotice } from "@/components/NawabanUI";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AnswerResponse, AskItem } from "@/lib/types";

// Presentation only; answer authority and draft lifecycle follow the existing API.

// Persist the established verdict and supplement marker independently of display locale.
const ACCEPT_VERDICT = zhCN.acceptVerdict;
const KIND_ACTION_LABEL: Record<string, TranslationKey> = {
  authorize: "approve",
  accept: "acknowledge",
  decide: "confirmDecision",
};

export function AskCard({
  ask,
  onAnswer,
  onDone,
  onSelectTask,
}: {
  ask: AskItem;
  onAnswer: (verdict: string, reject: boolean) => Promise<AnswerResponse>;
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
      const r = await onAnswer(verdict, reject);
      notice(t("resolvedAsk", { id: ask.id }), "success", r.out || undefined);
      close();
      onDone();
    } catch (e) {
      // The view rejects with `unknown` set when it cannot tell whether the answer was recorded.
      if ((e as { unknown?: boolean } | null)?.unknown) setUnknown(true);
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
            <Badge variant="yellow" size="bold">
              {t("handsOn")}
            </Badge>
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
                  onChange={(event) => setOtherText(event.target.value)}
                  placeholder={t("answerPlaceholder")}
                  value={otherText}
                />
              ) : (
                selectedIdx != null && (
                  <Textarea
                    aria-label={t("supplementDetails")}
                    onChange={(event) => setSupplement(event.target.value)}
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
              <Button
                key={id}
                variant="link"
                size="link"
                className="detail-code-link"
                onClick={() => onSelectTask(id)}
              >
                <Badge
                  variant="soft"
                  size="bold"
                  className="whitespace-normal break-words text-left"
                >
                  {id}
                </Badge>
              </Button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-body-regular text-text-error-primary">
            {unknown ? t("unknownAnswer") : error}
          </p>
        )}
        {unknown && (
          <Button variant="outline" size="lg" onClick={onDone}>
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
              variant="outline"
            >
              {t("requestChanges")}
            </Button>
            <Button
              disabled={unknown || busy}
              onClick={() => submit(ACCEPT_VERDICT, false)}
            >
              {t("acknowledge")}
            </Button>
          </>
        ) : isDecide && hasOptions ? (
          <Button
            disabled={unknown || busy || !decideVerdict}
            onClick={() => submit(decideVerdict, false, resetDecide)}
            title={selectedIdx == null ? t("selectOption") : undefined}
          >
            {t(KIND_ACTION_LABEL.decide)}
          </Button>
        ) : (
          <Button
            disabled={unknown || busy}
            onClick={() => setDialog({ reject: false })}
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
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={
              (dialog?.reject ? t("rejectReason") : t("answer")) + t("recordedVerbatim")
            }
            value={answer}
          />
          <footer className="answer-actions">
            <Button
              disabled={unknown || busy}
              onClick={() => setDialog(null)}
              variant="outline"
              size="lg"
            >
              {t("cancel")}
            </Button>
            <Button
              size="lg"
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
