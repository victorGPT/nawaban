import type { Ref } from "react";
import { t, useLocale } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Surface } from "@/components/NawabanUI";
import type { Project } from "@/lib/types";

export function CaptureForm({ content, onContentChange, onSave, busy, unknown, failure, project, textareaRef }: {
  content: string;
  onContentChange: (content: string) => void;
  onSave: () => void;
  busy: boolean;
  /** The last save may or may not have landed; the text is locked until it is retried. */
  unknown: boolean;
  failure: string;
  project: Project;
  textareaRef: Ref<HTMLTextAreaElement>;
}) {
  useLocale();
  return <Surface className="flex flex-col gap-4 p-4">
    <p className="text-body-regular text-text-secondary">{t("captureIntro")}</p>
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="capture-idea">{t("captureIdea")}</Label>
      <Textarea id="capture-idea" ref={textareaRef} value={content}
        onChange={(event) => onContentChange(event.target.value)}
        disabled={busy || unknown} maxLength={4000} rows={3} />
    </div>
    <div className="flex items-center gap-3">
      <Button size="lg" onClick={onSave} disabled={busy || !content.trim()}>
        {busy ? t("captureSaving") : unknown ? t("captureRetry") : t("captureSave")}
      </Button>
      <span className="text-caption-1-regular text-text-tertiary">
        {t("captureProject", { project: project || t("noProject") })}
      </span>
    </div>
    {failure && <p role="alert" className="text-body-regular text-text-error-primary">
      {unknown ? t("captureUnknown") : failure}
    </p>}
  </Surface>;
}
