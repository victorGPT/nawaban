import { t as tr, useLocale } from "@/i18n";
import { ContentButton } from "@/components/NawabanUI";
import { UNGROUPED_EPIC, type EpicGroup } from "@/lib/modules-model";
import { cn } from "@/lib/utils";

export function ModuleRail({
  epics,
  current,
  onSelect,
}: {
  epics: EpicGroup[];
  current: string | undefined;
  onSelect: (epic: string) => void;
}) {
  useLocale();
  return (
    <div className="module-rail">
      <div className="flex flex-col px-2 py-3">
        <div className="flex h-7 items-center px-2 text-body-medium text-text-secondary">
          {tr("moduleRailTitle")}
        </div>
        {epics.map((e) => {
          const total = e.tasks.length;
          const active = current === e.epic;
          return (
            <ContentButton
              className={cn(
                "flex min-h-9 items-center gap-2 rounded-md px-2 text-left text-body-regular transition-colors",
                active
                  ? "bg-background-secondary-hover text-text-primary"
                  : "text-text-primary hover:bg-background-secondary-hover/50",
              )}
              key={e.epic}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(e.epic)}
              type="button"
            >
              <span className="min-w-0 flex-1 truncate">{e.epic === UNGROUPED_EPIC ? tr("ungrouped") : e.epic}</span>
              <span className="shrink-0 text-body-regular text-text-secondary">
                {total - e.counts.done}/{total}
              </span>
            </ContentButton>
          );
        })}
      </div>
    </div>
  );
}
