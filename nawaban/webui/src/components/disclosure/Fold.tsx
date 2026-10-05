import { t as tr, useLocale } from "@/i18n";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function Fold<T>({
  items,
  n,
  render,
}: {
  items: T[];
  n: number;
  render: (x: T, i: number) => React.ReactNode;
}) {
  useLocale();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, n);
  return (
    <>
      {shown.map(render)}
      {items.length > n && (
        <Button
          variant="link"
          size="link"
          className="detail-action self-start"
          onClick={() => setAll((v) => !v)}
          type="button"
        >
          {all ? tr("collapse") : tr("moreItems", { count: items.length - n })}
        </Button>
      )}
    </>
  );
}
