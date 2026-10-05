import { t as tr, useLocale } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { TaskCard, TaskTag } from "@/components/TaskCard";
import { isBlocked, type Index } from "@/lib/modules-model";
import { cn } from "@/lib/utils";
import type { ModuleTask } from "@/lib/types";

export function ModuleCard({
  t,
  ids,
  idx,
  dim,
  hot,
  onClick,
  hasAsk,
  onDecision,
}: {
  t: ModuleTask;
  ids: Set<string>;
  idx: Index;
  dim: boolean;
  hot: boolean;
  onClick: () => void;
  hasAsk: boolean;
  onDecision: () => void;
}) {
  useLocale();
  const xdep = new Set(
    (idx.upOf.get(t.i) ?? [])
      .filter((u) => !ids.has(u))
      .map((u) => {
        const e = idx.byId.get(u)?.e;
        return e && e !== "n/a" ? e : tr("ungrouped");
      }),
  );
  const blocked = isBlocked(t, idx);
  return (
    <TaskCard
      task={{ id: t.i, title: t.t, status: t.s, epic: t.e, live: t.live, waiting_on: t.waiting_on ?? null, active_at: t.active_at, regressed_by: t.rb }}
      hasAsk={hasAsk} onSelect={onClick} onDecision={onDecision}
      className={cn("transition-opacity", hot && "ring-1 ring-border-focus-ring", dim && "opacity-[.22]")}
    >
      {blocked && <Badge variant="yellow" size="bold">{tr("blocked")}</Badge>}
      {[...xdep].map((e) => <TaskTag label={`${tr("dependencyPrefix")}${e}`} key={e} />)}
    </TaskCard>
  );
}
