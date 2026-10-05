import { t as tr, useLocale } from "@/i18n";
import { Md } from "@/components/Md";
import { Button } from "@/components/ui/button";
import {
  SettingsRow,
  SettingsValueField,
} from "@/components/application/settings/settings-rows";
import { cn } from "@/lib/utils";

// Detail typography is defined in styles/nawaban-typography.css.

export function IdLink({
  id,
  onSelect,
}: {
  id: string;
  onSelect: (id: string) => void;
}) {
  useLocale();
  return (
    <Button
      variant="link"
      size="link"
      className="detail-code-link"
      onClick={() => onSelect(id)}
      type="button"
    >
      {id}
    </Button>
  );
}

export function Ids({
  ids,
  onSelect,
}: {
  ids: string[];
  onSelect: (id: string) => void;
}) {
  useLocale();
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <IdLink id={id} key={id} onSelect={onSelect} />
      ))}
    </span>
  );
}

export function H({ children, n }: { children: React.ReactNode; n?: number }) {
  useLocale();
  return (
    <h3 className="detail-section-title mb-3 flex items-center gap-2">
      {children}
      {n != null && <span className="detail-meta">{n}</span>}
    </h3>
  );
}

export function Bullets({ items }: { items: string[] }) {
  useLocale();
  return (
    <ul className="detail-list list-disc pl-5">
      {items.map((s, i) => (
        <li key={i}>
          <Md text={s} />
        </li>
      ))}
    </ul>
  );
}

// Read-only properties use a consistent label/value layout.
export function Attr({
  label,
  value,
  mono,
  empty,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  empty?: string;
}) {
  useLocale();
  const isEmpty = value == null || value === "";
  return (
    <SettingsRow label={label}>
      <SettingsValueField className={cn("detail-value", mono && "detail-mono")}>
        {isEmpty ? (empty ?? tr("noValue", { label })) : value}
      </SettingsValueField>
    </SettingsRow>
  );
}
