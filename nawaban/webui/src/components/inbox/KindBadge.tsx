import { t, useLocale } from "@/i18n";
import { KIND_LABEL } from "@/components/inbox/labels";
import { Badge } from "@/components/ui/badge";

export function KindBadge({ kind }: { kind: string }) {
  useLocale();
  return (
    <Badge
      variant={
        kind === "accept" ? "yellow" : kind === "decide" ? "purple" : "blue"
      }
      size="bold"
    >
      {KIND_LABEL[kind] ? t(KIND_LABEL[kind]) : kind}
    </Badge>
  );
}
