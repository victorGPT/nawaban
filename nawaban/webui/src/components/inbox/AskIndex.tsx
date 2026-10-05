import { t, useLocale } from "@/i18n";
import { KindBadge } from "@/components/inbox/KindBadge";
import { KIND_LABEL } from "@/components/inbox/labels";
import { ContentButton } from "@/components/NawabanUI";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AskGroup, AskItem } from "@/lib/types";

export function AskIndex({
  groups,
  selected,
  onSelect,
}: {
  groups: AskGroup[];
  selected: AskItem | null;
  onSelect: (id: number) => void;
}) {
  useLocale();
  return groups.map((g) => (
    <section key={g.kind}>
      <h2 className="flex items-center px-4 py-2 text-body-medium text-text-secondary">
        {KIND_LABEL[g.kind] ? t(KIND_LABEL[g.kind]) : g.title}{" "}
        <span className="ml-2 text-body-regular">{g.items.length}</span>
      </h2>
      {g.items.map((a) => (
        <ContentButton
          className={cn(
            "inbox-item w-full border-b px-4 py-3 text-left transition-colors",
            selected?.id === a.id
              ? "bg-background-secondary-hover"
              : "hover:bg-background-secondary-hover/40",
          )}
          key={a.id}
          aria-current={selected?.id === a.id ? "true" : undefined}
          onClick={() => onSelect(a.id)}
          type="button"
        >
          <div className="flex flex-wrap items-center gap-2 text-body-regular text-text-secondary">
            <KindBadge kind={a.kind} />
            <span className="text-body-regular">#{a.id}</span>
            {a.hands_on && (
              <Badge variant="yellow" size="bold">
                {t("handsOn")}
              </Badge>
            )}
            <span className="ml-auto">{t("daysCount", { days: a.stalled_days })}</span>
          </div>
          <p className="line-clamp-2 text-body-regular text-text-primary">
            {a.question}
          </p>
        </ContentButton>
      ))}
    </section>
  ));
}
