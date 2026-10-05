import { t as tr, useLocale } from "@/i18n";
import { useState } from "react";
import { Md } from "@/components/Md";
import { Button } from "@/components/ui/button";

// Collapse long activity prose to three lines until expanded.
export function Clamp({ text }: { text: string }) {
  useLocale();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Md className={open ? "" : "line-clamp-3"} text={text} />
      <Button
        variant="link"
        size="link"
        className="detail-action"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? tr("collapse") : tr("expandFullText")}
      </Button>
    </div>
  );
}
