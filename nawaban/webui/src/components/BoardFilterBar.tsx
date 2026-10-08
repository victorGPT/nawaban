import { t as tr, useLocale } from "@/i18n";
import { parseDate } from "@internationalized/date";
import { DateRangePicker } from "@/components/application/date-picker/date-range-picker";
import { Button } from "@/components/ui/button";
import type { DateRange } from "@/lib/types";

// Preserve updated-date filtering and Monday-based weeks using BoardUI controls.

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (d: Date, days: number) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
const monday = (d: Date) => shift(d, -((d.getDay() + 6) % 7));

const PRESETS: { id: string; label: string; range: () => DateRange }[] = [
  {
    id: "today",
    get label() { return tr("today"); },
    range: () => ({ since: iso(new Date()), until: iso(new Date()) }),
  },
  {
    id: "yesterday",
    get label() { return tr("yesterday"); },
    range: () => ({
      since: iso(shift(new Date(), -1)),
      until: iso(shift(new Date(), -1)),
    }),
  },
  {
    id: "week",
    get label() { return tr("thisWeek"); },
    range: () => ({ since: iso(monday(new Date())), until: iso(new Date()) }),
  },
  {
    id: "lastweek",
    get label() { return tr("lastWeek"); },
    range: () => ({
      since: iso(shift(monday(new Date()), -7)),
      until: iso(shift(monday(new Date()), -1)),
    }),
  },
  {
    id: "7d",
    get label() { return tr("last7Days"); },
    range: () => ({
      since: iso(shift(new Date(), -6)),
      until: iso(new Date()),
    }),
  },
];

export function BoardFilterBar({
  range,
  onChange,
}: {
  range: DateRange | null;
  onChange: (r: DateRange | null) => void;
}) {
  useLocale();
  const activePreset = PRESETS.find((p) => {
    if (!range) return false;
    const r = p.range();
    return r.since === range.since && r.until === range.until;
  })?.id;

  return (
    <div className="date-filter">
      <span className="text-body-regular">{tr("updated")}</span>
      {PRESETS.map((p) => (
        <Button
          key={p.id}
          variant={activePreset === p.id ? "outline" : "ghost"}
          className={
            activePreset !== p.id
              ? "bg-transparent text-text-secondary"
              : undefined
          }
          aria-pressed={activePreset === p.id}
          onClick={() => onChange(activePreset === p.id ? null : p.range())}
        >
          {p.label}
        </Button>
      ))}
      <DateRangePicker
        aria-label={tr("customUpdatedRange")}
        placeholder={tr("customDates")}
        value={
          range
            ? { start: parseDate(range.since), end: parseDate(range.until) }
            : null
        }
        onChange={(value) =>
          onChange(
            value
              ? { since: value.start.toString(), until: value.end.toString() }
              : null,
          )
        }
      />
      {range && (
        <Button
          variant="ghost"
          className="bg-transparent text-text-secondary"
          onClick={() => onChange(null)}
        >{tr("clearFilters")}</Button>
      )}
    </div>
  );
}
