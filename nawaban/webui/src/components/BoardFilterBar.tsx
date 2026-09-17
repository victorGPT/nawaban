import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DateRange } from "@/lib/api";
import { cn } from "@/lib/utils";

// Linear 式筛选栏(用户 2026-09-08 选定):「更新时间」快捷 chip + 自定义范围,与搜索叠加。
// 语义同 GitHub Projects 的 updated:@today —— 列仍按当前状态分,只留时间段内动过的卡。
// 周从周一起(国内习惯)。原生 date input,不装 picker。

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shift = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
const monday = (d: Date) => shift(d, -((d.getDay() + 6) % 7));

const PRESETS: { id: string; label: string; range: () => DateRange }[] = [
  { id: "today", label: "今天", range: () => ({ since: iso(new Date()), until: iso(new Date()) }) },
  { id: "yesterday", label: "昨天", range: () => ({ since: iso(shift(new Date(), -1)), until: iso(shift(new Date(), -1)) }) },
  { id: "week", label: "本周", range: () => ({ since: iso(monday(new Date())), until: iso(new Date()) }) },
  { id: "lastweek", label: "上周", range: () => ({ since: iso(shift(monday(new Date()), -7)), until: iso(shift(monday(new Date()), -1)) }) },
  { id: "7d", label: "最近 7 天", range: () => ({ since: iso(shift(new Date(), -6)), until: iso(new Date()) }) },
];

export function BoardFilterBar({
  range,
  onChange,
}: {
  range: DateRange | null;
  onChange: (r: DateRange | null) => void;
}) {
  const [custom, setCustom] = useState<DateRange>(range ?? { since: "", until: "" });
  const activePreset = PRESETS.find((p) => {
    if (!range) return false;
    const r = p.range();
    return r.since === range.since && r.until === range.until;
  })?.id;

  const applyCustom = (next: DateRange) => {
    setCustom(next);
    if (next.since && next.until && next.until >= next.since) onChange(next);
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-4 text-xs">
      <span className="mr-1 text-muted-foreground">更新时间</span>
      {PRESETS.map((p) => (
        <Button
          className={cn("text-xs", activePreset === p.id && "bg-accent text-foreground")}
          key={p.id}
          onClick={() => onChange(activePreset === p.id ? null : p.range())}
          size="xs"
          variant="ghost"
        >
          {p.label}
        </Button>
      ))}
      <span className="mx-1 h-4 w-px bg-border" />
      <input
        aria-label="起始日期"
        className="h-6 rounded-md border bg-transparent px-1.5 font-mono text-foreground outline-none focus:border-card-hover-border"
        onChange={(e) => applyCustom({ ...custom, since: e.target.value })}
        type="date"
        value={custom.since}
      />
      <span className="text-muted-foreground">–</span>
      <input
        aria-label="结束日期"
        className="h-6 rounded-md border bg-transparent px-1.5 font-mono text-foreground outline-none focus:border-card-hover-border"
        onChange={(e) => applyCustom({ ...custom, until: e.target.value })}
        type="date"
        value={custom.until}
      />
      {range && (
        <Button
          className="ml-auto text-xs text-muted-foreground"
          onClick={() => {
            onChange(null);
            setCustom({ since: "", until: "" });
          }}
          size="xs"
          variant="ghost"
        >
          {range.since === range.until ? range.since : `${range.since} – ${range.until}`}
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}
