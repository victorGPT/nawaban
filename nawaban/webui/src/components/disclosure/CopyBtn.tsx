import { t as tr, useLocale } from "@/i18n";
import { useState } from "react";
import { RiCheckLine as Check, RiFileCopyLine as Copy } from "@remixicon/react";
import { useNotice } from "@/components/NawabanUI";
import { Button } from "@/components/ui/button";

export function CopyBtn({ text, label }: { text: string; label?: string }) {
  useLocale();
  const [ok, setOk] = useState(false);
  const notice = useNotice();
  return (
    <Button
      variant="link"
      size="link"
      className="inline-flex items-center gap-1 detail-action hover:text-text-primary"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1200);
          })
          .catch(() => notice(tr("copyFailed"), "error"));
      }}
      title={tr("copyText", { text })}
      type="button"
    >
      {ok ? <Check className="size-3" /> : <Copy className="size-3" />}
      {label}
    </Button>
  );
}
