import { t as tr, useLocale } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// App composition: the compact project/module picker, on the shadcn Select.
export function ModuleSelect({
  modules,
  value,
  onValueChange,
  allLabel = tr("allEpics"),
  ariaLabel = tr("filterEpic"),
  className,
  getLabel = (value: string) => value,
}: {
  modules: string[];
  value: string;
  onValueChange: (value: string) => void;
  allLabel?: string;
  ariaLabel?: string;
  className?: string;
  getLabel?: (value: string) => string;
}) {
  useLocale();
  const items = [
    { value: "all", label: allLabel },
    ...modules.map((module) => ({ value: module, label: getLabel(module) })),
  ];

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onValueChange((next as string | null) ?? "all")}
      modal={false}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        size="sm"
        className={cn("max-w-[260px] bg-background-primary-default px-[7px] py-1 text-body-2-medium text-text-primary shadow-xs data-[size=sm]:rounded-2lg", className)}
      >
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="bui-popup-layer">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="text-body-2-medium">
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
