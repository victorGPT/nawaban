"use client";

import { Children, createContext, isValidElement, useContext } from "react";
import type { HTMLAttributes, Key, ReactNode, Ref } from "react";
import { Select as BaseSelect } from "@base-ui/react/select";
import { MENU_ITEM, MENU_ITEM_ACTIVE, MENU_ITEMS_CONTAINER, MENU_POPOVER_SURFACE, MENU_POPOVER_WIDTH } from "@/components/base/dropdown/menu-styles";
import { ChevronDownSmall } from "@/components/foundations/icons/chevrons";
import { cx } from "@/utils/cx";

export type SelectSize = "sm" | "md";
const SelectContext = createContext<{ size: SelectSize; disabledKeys: Set<Key> }>({ size: "md", disabledKeys: new Set() });

type SelectValueState<T> = {
  selectedItem: T | null;
  selectedText: string;
  isPlaceholder: boolean;
};

/** BoardUI's single-selection API, backed by Base UI's listbox. */
export interface SelectProps<T extends object> extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "defaultValue" | "onChange"> {
  triggerClassName?: string;
  popoverClassName?: string;
  size?: SelectSize;
  children: ReactNode;
  items?: Iterable<T>;
  renderValue?: ReactNode | ((values: SelectValueState<T>) => ReactNode);
  selectedKey?: Key | null;
  defaultSelectedKey?: Key;
  onSelectionChange?: (key: Key | null) => void;
  disabledKeys?: Iterable<Key>;
  isDisabled?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
  isOpen?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  name?: string;
  placeholder?: string;
  ref?: Ref<HTMLDivElement>;
}

export function Select<T extends object>({ className, triggerClassName, popoverClassName, size = "md", children, items, renderValue, ref, selectedKey, defaultSelectedKey, onSelectionChange, disabledKeys, isDisabled, isRequired, isInvalid, isOpen, defaultOpen, onOpenChange, name, placeholder = "Select an item", "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy, ...props }: SelectProps<T>) {
  const options = Children.toArray(children).filter(isValidElement<SelectItemProps>).map((child) => ({ value: child.props.id, label: child.props.children ?? child.props.textValue }));
  const disabledSet = new Set(disabledKeys);
  return (
    <div ref={ref} {...props} className={cx("group flex flex-col", className)}>
      <BaseSelect.Root items={options} value={selectedKey} defaultValue={defaultSelectedKey} onValueChange={onSelectionChange} open={isOpen} defaultOpen={defaultOpen} onOpenChange={onOpenChange} disabled={isDisabled} required={isRequired} name={name} modal={false}>
        <BaseSelect.Trigger aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} aria-describedby={ariaDescribedBy} aria-invalid={isInvalid || undefined} className={cx(
          "group/select flex w-full cursor-pointer items-center justify-between rounded-2lg",
          "border border-border-button-default bg-background-primary-default shadow-xs text-text-primary",
          "transition-[background-color,border-color,box-shadow,padding,font-size] duration-200 ease",
          "hover:bg-background-primary-hover hover:border-border-button-hover",
          "outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-border-focus-ring",
          "disabled:cursor-not-allowed disabled:bg-background-primary-disabled disabled:text-text-tertiary disabled:shadow-none",
          size === "sm" ? "gap-1 px-[7px] py-1 text-body-2-medium" : "gap-1.5 px-2.5 py-2 text-body-medium", triggerClassName,
        )}>
          <BaseSelect.Value className={cx("flex min-w-0 items-center truncate", size === "sm" ? "gap-1" : "gap-[5px]")}>
            {(value: Key | null) => {
              const option = options.find((item) => item.value === value);
              const content = option?.label ?? placeholder;
              if (typeof renderValue !== "function") return renderValue ?? content;
              const selectedItem = items ? Array.from(items).find((item) => "id" in item && item.id === value) ?? null : null;
              return renderValue({ selectedItem, selectedText: typeof content === "string" ? content : String(value ?? ""), isPlaceholder: value == null });
            }}
          </BaseSelect.Value>
          <BaseSelect.Icon className="shrink-0"><ChevronDownSmall className={cx("text-text-secondary transition-transform duration-200 ease group-data-[popup-open]/select:rotate-180", size === "sm" ? "size-3.5" : "size-4")} /></BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner sideOffset={4} align="start" alignItemWithTrigger={false} className="bui-popup-layer">
            <BaseSelect.Popup className={cx(MENU_POPOVER_WIDTH, MENU_POPOVER_SURFACE, "p-2", popoverClassName)}>
              <BaseSelect.List className={cx(MENU_ITEMS_CONTAINER, "max-h-[min(240px,calc(var(--available-height)-1rem))] overflow-auto")}>
                <SelectContext.Provider value={{ size, disabledKeys: disabledSet }}>{children}</SelectContext.Provider>
              </BaseSelect.List>
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
}

interface SelectItemState { isFocused: boolean; isSelected: boolean; isDisabled: boolean }
export interface SelectItemProps extends Omit<HTMLAttributes<HTMLDivElement>, "id" | "className"> {
  id: Key;
  children?: ReactNode;
  textValue?: string;
  isDisabled?: boolean;
  className?: string | ((state: SelectItemState) => string);
}
export function SelectItem({ id, textValue, isDisabled, className, children, ...props }: SelectItemProps) {
  const { size, disabledKeys } = useContext(SelectContext);
  return <BaseSelect.Item {...props} value={id} label={textValue} disabled={isDisabled || disabledKeys.has(id)} className={(state) => cx(
    MENU_ITEM, size === "sm" ? "px-2 py-1.5 text-body-2-medium" : "text-body-medium",
    (state.highlighted || state.selected) && MENU_ITEM_ACTIVE, state.disabled && "cursor-not-allowed text-text-disabled",
    typeof className === "function" ? className({ isFocused: state.highlighted, isSelected: state.selected, isDisabled: state.disabled }) : className,
  )}><BaseSelect.ItemText>{children ?? textValue}</BaseSelect.ItemText></BaseSelect.Item>;
}
