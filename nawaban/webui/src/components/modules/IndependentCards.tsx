import { t as tr, useLocale } from "@/i18n";
import type { ReactNode } from "react";
import { ST } from "@/lib/modules-model";
import type { ModuleTask } from "@/lib/types";

export function IndependentCards({
  loose,
  card,
}: {
  loose: ModuleTask[];
  card: (t: ModuleTask) => ReactNode;
}) {
  useLocale();
  return (
    <div className="mt-2 border-t pt-4">
      <h3 className="mb-2 flex h-7 items-center text-body-medium text-text-secondary">
        {tr("independent")}{loose.length}
      </h3>
      <div className="flex flex-wrap gap-2">
        {ST.flatMap((s) => loose.filter((t) => t.s === s)).map(
          (t) => (
            <div className="w-[250px]" key={t.i}>
              {card(t)}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
