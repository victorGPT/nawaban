import { useCallback, useEffect, useRef, useState } from "react";
import { t, useLocale } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LoadState, Surface } from "@/components/NawabanUI";
import { fetchCaptures, postCapture, newCaptureId, CaptureError, type Capture, type CaptureDraft } from "@/lib/captures-api";
import type { Project } from "@/lib/api";
import { useReadOnlyData } from "@/lib/use-read-only-data";
import { ago } from "@/lib/utils";

export function CaptureSource({ item }: { item: Capture }) {
  useLocale();
  return <div className="flex flex-col gap-2">
    <code className="text-caption-1-regular text-text-tertiary">{item.id}</code>
    <p className="whitespace-pre-wrap break-words text-body-regular text-text-primary">{item.content}</p>
  </div>;
}

export function CaptureView({ project, query, onSelectTask }: {
  project: Project; query: string; onSelectTask: (id: string) => void;
}) {
  useLocale();
  const load = useCallback(() => fetchCaptures(project), [project]);
  const { data, error, refresh } = useReadOnlyData(load);
  const [content, setContent] = useState("");
  const [history, setHistory] = useState(false);
  const [saved, setSaved] = useState<Capture[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [unknown, setUnknown] = useState(false);
  const attempt = useRef<CaptureDraft | null>(null);
  const submitting = useRef(false);
  const active = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  // Locally acknowledged writes appear immediately, even if an older poll is in flight.
  const items = [...(data ?? [])];
  items.unshift(...saved.filter((item) => !items.some((current) => current.id === item.id)));
  const visible = items.filter((item) =>
    (history || item.status === "pending") &&
    `${item.content} ${item.id} ${item.task_id ?? ""} ${item.reason ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );

  async function save() {
    if (submitting.current || !content.trim()) return;
    submitting.current = true;
    setBusy(true);
    setFailure("");
    attempt.current ??= { id: newCaptureId(), content: content.trim(), project };
    try {
      const item = await postCapture(attempt.current);
      if (!active.current) return;
      setSaved((previous) => [item, ...previous.filter((existing) => existing.id !== item.id)]);
      setContent("");
      setUnknown(false);
      attempt.current = null;
      refresh();
      textarea.current?.focus();
    } catch (cause) {
      if (!active.current) return;
      const uncertain = cause instanceof CaptureError && cause.unknown;
      setUnknown(uncertain);
      setFailure(String(cause));
      if (!uncertain) attempt.current = null;
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <section className="flex flex-col gap-6 p-6" aria-label={t("capture")}>
    <Surface className="flex flex-col gap-4 p-4">
      <p className="text-body-regular text-text-secondary">{t("captureIntro")}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="capture-idea">{t("captureIdea")}</Label>
        <Textarea id="capture-idea" ref={textarea} value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={busy || unknown} maxLength={4000} rows={3} />
      </div>
      <div className="flex items-center gap-3">
        <Button size="lg" onClick={() => void save()} disabled={busy || !content.trim()}>
          {busy ? t("captureSaving") : unknown ? t("captureRetry") : t("captureSave")}
        </Button>
        <span className="text-caption-1-regular text-text-tertiary">
          {t("captureProject", { project: project || t("noProject") })}
        </span>
      </div>
      {failure && <p role="alert" className="text-body-regular text-text-error-primary">
        {unknown ? t("captureUnknown") : failure}
      </p>}
    </Surface>
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-headline-medium">{history ? t("captureAll") : t("capturePending")}</h2>
      <Button variant="outline" size="lg" aria-pressed={history} onClick={() => setHistory(!history)}>
        {history ? t("captureShowPending") : t("captureShowHistory")}
      </Button>
    </div>
    {error && <LoadState error>{error}</LoadState>}
    {!data && !error && !saved.length && <LoadState>{t("captureLoading")}</LoadState>}
    {data && !visible.length && <LoadState>{t("captureEmpty")}</LoadState>}
    {visible.map((item) => <Surface key={item.id} className="flex flex-col gap-3 p-4">
      <CaptureSource item={item} />
      <div className="flex flex-wrap items-center gap-3 text-caption-1-regular text-text-tertiary">
        <span>{ago(item.created_at)}</span>
        <span>{item.project || t("noProject")}</span>
        <span>{t(item.status === "pending" ? "capturePending" : item.status === "converted" ? "captureConverted" : "captureDiscarded")}</span>
        {item.task_id && <Button variant="link" size="link" onClick={() => onSelectTask(item.task_id!)}>{item.task_id}</Button>}
      </div>
      {item.reason && <p className="whitespace-pre-wrap break-words text-body-regular text-text-secondary">{t("captureReason", { reason: item.reason })}</p>}
    </Surface>)}
  </section>;
}
