import { t as tr, useLocale } from "@/i18n";
import { Switch } from "@/components/ui/switch";
import { UNGROUPED_EPIC, donePct, type EpicGroup } from "@/lib/modules-model";

export function ModuleHeader({
  group,
  stageOf,
  stages,
  focusMode,
  onFocusModeChange,
}: {
  group: EpicGroup;
  stageOf: Map<string, number>;
  stages: number;
  focusMode: boolean;
  onFocusModeChange: (checked: boolean) => void;
}) {
  useLocale();
  const list = group.tasks;
  const c = group.counts;
  const wip = list.filter((t) => t.s === "in_progress" || t.s === "claimed");
  const nowLine = wip.length
    ? tr("currentWork") +
      wip
        .map(
          (t) =>
            `${t.i}${stageOf.has(t.i) ? tr("stageOf", { stage: stageOf.get(t.i)!, total: stages }) : tr("independentSuffix")}`,
        )
        .join(" · ")
    : tr("noInProgress");
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-title-1-semibold">{group.epic === UNGROUPED_EPIC ? tr("ungrouped") : group.epic}</h2>
        <p className="mt-1 text-body-regular text-text-secondary">
          {tr("moduleSummary", { count: list.length, percent: donePct(c), done: c.done,
            ready: c["staging-verified"], assigned: c.claimed, active: c.in_progress, open: c.open })}
        </p>
        <p className="mt-2 text-body-regular text-text-secondary break-words">
          {nowLine}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-body-regular text-text-secondary select-none">
        {tr("focusModeLabel")}
        <Switch
          aria-label={tr("focusMode")}
          checked={focusMode}
          onCheckedChange={onFocusModeChange}
          size="sm"
        />
      </div>
    </div>
  );
}
