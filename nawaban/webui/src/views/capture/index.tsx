import { useCallback, useEffect, useRef, useState } from "react";
import { t, useLocale } from "@/i18n";
import { CaptureCard } from "@/components/capture/CaptureCard";
import { CaptureForm } from "@/components/capture/CaptureForm";
import { Button } from "@/components/ui/button";
import { LoadState } from "@/components/NawabanUI";
import { fetchCaptures, postCapture, newCaptureId, CaptureError, type Capture, type CaptureDraft } from "@/lib/captures-api";
import type { Project } from "@/lib/api";
import { useReadOnlyData } from "@/lib/use-read-only-data";

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
    <CaptureForm content={content} onContentChange={setContent} onSave={() => void save()}
      busy={busy} unknown={unknown} failure={failure} project={project} textareaRef={textarea} />
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-headline-medium">{history ? t("captureAll") : t("capturePending")}</h2>
      <Button variant="outline" size="lg" aria-pressed={history} onClick={() => setHistory(!history)}>
        {history ? t("captureShowPending") : t("captureShowHistory")}
      </Button>
    </div>
    {error && <LoadState error>{error}</LoadState>}
    {!data && !error && !saved.length && <LoadState>{t("captureLoading")}</LoadState>}
    {data && !visible.length && <LoadState>{t("captureEmpty")}</LoadState>}
    {visible.map((item) => <CaptureCard key={item.id} item={item} onSelectTask={onSelectTask} />)}
  </section>;
}
