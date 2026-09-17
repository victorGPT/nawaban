import { t as tr, useLocale } from "@/i18n";
import { Select } from "@base-ui/react/select";
import {
  MENU_ITEM,
  MENU_ITEM_ACTIVE,
  MENU_ITEMS_CONTAINER,
  MENU_POPOVER_SURFACE,
  MENU_POPOVER_WIDTH,
} from "@/components/base/dropdown/menu-styles";
import { ChevronDownSmall } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";

// Pilot: Base UI owns behavior; the existing BoardUI select/menu recipe owns visuals.
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
    <Select.Root
      items={items}
      value={value}
      onValueChange={(next) => onValueChange(next ?? "all")}
      modal={false}
    >
      <Select.Trigger
        aria-label={ariaLabel}
        className={cx(
          "group flex min-w-0 max-w-[260px] cursor-pointer items-center justify-between rounded-2lg",
          "border border-border-button-default bg-background-primary-default shadow-xs text-text-primary",
          "transition-[background-color,border-color,box-shadow,padding,font-size] duration-200 ease",
          "hover:bg-background-primary-hover hover:border-border-button-hover",
          "outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-border-focus-ring",
          "gap-1 px-[7px] py-1 text-body-2-medium",
          className,
        )}
      >
        <Select.Value className="min-w-0 truncate" />
        <Select.Icon className="shrink-0">
          <ChevronDownSmall className="size-3.5 shrink-0 text-text-secondary transition-transform duration-200 ease group-data-[popup-open]:rotate-180" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} align="start" alignItemWithTrigger={false} className="bui-popup-layer">
          <Select.Popup
            className={cx(
              MENU_POPOVER_WIDTH,
              MENU_POPOVER_SURFACE,
              "p-2 origin-top-left data-[side=top]:origin-bottom-left",
              "data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:blur-[2px]",
              "data-[ending-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:blur-[2px]",
            )}
          >
            <Select.List className={cx(MENU_ITEMS_CONTAINER, "max-h-[min(240px,calc(var(--available-height)-1rem))] overflow-auto")}>
              {items.map((item) => (
                <Select.Item
                  key={item.value}
                  value={item.value}
                  className={(state) => cx(
                    MENU_ITEM,
                    "px-2 py-1.5 text-body-2-medium",
                    (state.highlighted || state.selected) && MENU_ITEM_ACTIVE,
                  )}
                >
                  <Select.ItemText>{item.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
